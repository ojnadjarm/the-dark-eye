//! EGL on the window the eye already has: `EGL_EXT_platform_xcb` takes the
//! x11rb connection and the XID as they are, so the override-redirect ARGB
//! window is untouched. Any failure here is an error the caller logs before
//! falling back to cairo.
use khronos_egl as egl;
use std::error::Error;
use std::ffi::c_void;
use x11rb::xcb_ffi::XCBConnection as XConn;

const PLATFORM_XCB_EXT: egl::Enum = 0x31DC;
const PLATFORM_SURFACELESS_MESA: egl::Enum = 0x31DD;

/// `eglSwapBuffersWithDamageKHR` — rects are `x, y, w, h` quadruples with the
/// origin at the surface's bottom-left.
type SwapDamage = unsafe extern "C" fn(egl::EGLDisplay, egl::EGLSurface, *const egl::Int, egl::Int) -> egl::Boolean;

pub struct Egl {
    instance: egl::DynamicInstance<egl::EGL1_5>,
    display: egl::Display,
    /// `None` on a surfaceless context: the FBO is the only render target.
    surface: Option<egl::Surface>,
    context: egl::Context,
    /// present-with-damage, when the display advertises the extension
    swap_damage: Option<SwapDamage>,
}

impl Egl {
    /// A current GL ES 3.0 context on `xid`, with vsync off — the scheduler is
    /// the clock. The config is matched on the window's own visual.
    pub fn on_window(conn: &XConn, xid: u32, visual_id: u32) -> Result<Self, Box<dyn Error>> {
        let instance = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required()? };
        let display = unsafe {
            instance.get_platform_display(PLATFORM_XCB_EXT, conn.get_raw_xcb_connection() as *mut c_void, &[egl::ATTRIB_NONE])?
        };
        let (maj, min) = instance.initialize(display)?;
        instance.bind_api(egl::OPENGL_ES_API)?;
        let cfg_attribs = [
            egl::SURFACE_TYPE, egl::WINDOW_BIT,
            egl::RENDERABLE_TYPE, egl::OPENGL_ES3_BIT,
            egl::RED_SIZE, 8, egl::GREEN_SIZE, 8, egl::BLUE_SIZE, 8, egl::ALPHA_SIZE, 8,
            egl::NONE,
        ];
        let mut configs = Vec::with_capacity(64);
        instance.choose_config(display, &cfg_attribs, &mut configs)?;
        let cfg = configs
            .iter()
            .copied()
            .find(|c| instance.get_config_attrib(display, *c, egl::NATIVE_VISUAL_ID).ok() == Some(visual_id as i32))
            .ok_or("no EGL config matches the window's 32-bit visual")?;
        let context = instance.create_context(display, cfg, None, &[egl::CONTEXT_MAJOR_VERSION, 3, egl::CONTEXT_MINOR_VERSION, 0, egl::NONE])?;
        let mut xid = xid;
        let surface = unsafe {
            instance.create_platform_window_surface(display, cfg, &mut xid as *mut u32 as *mut c_void, &[egl::ATTRIB_NONE])?
        };
        instance.make_current(display, Some(surface), Some(surface), Some(context))?;
        instance.swap_interval(display, 0)?;
        let exts = instance.query_string(Some(display), egl::EXTENSIONS)?.to_string_lossy().into_owned();
        let swap_damage = ["EGL_KHR_swap_buffers_with_damage", "EGL_EXT_swap_buffers_with_damage"]
            .iter()
            .find(|e| exts.contains(**e))
            .and_then(|e| instance.get_proc_address(if e.starts_with("EGL_KHR") { "eglSwapBuffersWithDamageKHR" } else { "eglSwapBuffersWithDamageEXT" }))
            .map(|p| unsafe { std::mem::transmute::<extern "system" fn(), SwapDamage>(p) });
        let e = Self { instance, display, surface: Some(surface), context, swap_damage };
        let gl = e.gl();
        unsafe {
            use glow::HasContext;
            eprintln!("[eye-render] EGL {maj}.{min} · {} · {}", gl.get_parameter_string(glow::RENDERER), gl.get_parameter_string(glow::VERSION));
        }
        Ok(e)
    }

    /// A current GL ES 3.0 context with no surface at all — no X server, no
    /// window: `EGL_MESA_platform_surfaceless` plus `EGL_KHR_surfaceless_context`,
    /// and the caller renders into an FBO. This is what the parity harness runs on.
    pub fn surfaceless() -> Result<Self, Box<dyn Error>> {
        let instance = unsafe { egl::DynamicInstance::<egl::EGL1_5>::load_required()? };
        let display = unsafe {
            instance.get_platform_display(PLATFORM_SURFACELESS_MESA, egl::DEFAULT_DISPLAY, &[egl::ATTRIB_NONE])?
        };
        let (maj, min) = instance.initialize(display)?;
        let exts = instance.query_string(Some(display), egl::EXTENSIONS)?.to_string_lossy().into_owned();
        if !exts.contains("EGL_KHR_surfaceless_context") {
            return Err("EGL_KHR_surfaceless_context is missing".into());
        }
        instance.bind_api(egl::OPENGL_ES_API)?;
        let cfg_attribs = [
            egl::SURFACE_TYPE, egl::PBUFFER_BIT,
            egl::RENDERABLE_TYPE, egl::OPENGL_ES3_BIT,
            egl::RED_SIZE, 8, egl::GREEN_SIZE, 8, egl::BLUE_SIZE, 8, egl::ALPHA_SIZE, 8,
            egl::NONE,
        ];
        let cfg = instance.choose_first_config(display, &cfg_attribs)?.ok_or("no surfaceless EGL config")?;
        let context = instance.create_context(display, cfg, None, &[egl::CONTEXT_MAJOR_VERSION, 3, egl::CONTEXT_MINOR_VERSION, 0, egl::NONE])?;
        instance.make_current(display, None, None, Some(context))?;
        let e = Self { instance, display, surface: None, context, swap_damage: None };
        let gl = e.gl();
        unsafe {
            use glow::HasContext;
            eprintln!("[parity] EGL {maj}.{min} surfaceless · {} · {}", gl.get_parameter_string(glow::RENDERER), gl.get_parameter_string(glow::VERSION));
        }
        Ok(e)
    }

    /// A `glow` context on the current EGL context.
    pub fn gl(&self) -> glow::Context {
        unsafe {
            glow::Context::from_loader_function(|s| self.instance.get_proc_address(s).map(|p| p as *const c_void).unwrap_or(std::ptr::null()))
        }
    }

    /// `glGetGraphicsResetStatusKHR`, for a caller that has already found
    /// `GL_KHR_robustness` in the context's extensions.
    pub fn reset_status(&self) -> Option<unsafe extern "C" fn() -> u32> {
        self.instance
            .get_proc_address("glGetGraphicsResetStatusKHR")
            .map(|p| unsafe { std::mem::transmute::<extern "system" fn(), unsafe extern "C" fn() -> u32>(p) })
    }

    /// Present the window's back buffer; a surfaceless context has none.
    pub fn swap(&self) -> Result<(), Box<dyn Error>> {
        if let Some(s) = self.surface {
            self.instance.swap_buffers(self.display, s)?;
        }
        Ok(())
    }

    /// Whether this display can present with a damage region.
    pub fn has_swap_damage(&self) -> bool {
        self.swap_damage.is_some()
    }

    /// Present only `rects` (`x, y, w, h`, bottom-left origin) as changed since
    /// the last frame; falls back to a full swap when the extension is absent.
    pub fn swap_with_damage(&self, rects: &[egl::Int]) -> Result<(), Box<dyn Error>> {
        let (Some(f), Some(s)) = (self.swap_damage, self.surface) else {
            return self.swap();
        };
        let ok = unsafe { f(self.display.as_ptr(), s.as_ptr(), rects.as_ptr(), (rects.len() / 4) as egl::Int) };
        if ok == egl::TRUE {
            Ok(())
        } else {
            Err("eglSwapBuffersWithDamage failed".into())
        }
    }
}

impl Drop for Egl {
    fn drop(&mut self) {
        let _ = self.instance.make_current(self.display, None, None, None);
        if let Some(s) = self.surface {
            let _ = self.instance.destroy_surface(self.display, s);
        }
        let _ = self.instance.destroy_context(self.display, self.context);
    }
}
