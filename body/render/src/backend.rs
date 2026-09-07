//! The two ways the eye reaches the window: cairo into an XCB surface, or GL
//! ES 3.0 through EGL on the same window. Both draw the same `Sim` and `Frame`.
use crate::eye::Scene;
use crate::sched::{Kind, State};
use crate::sim::{Frame, Sim};
use crate::window::{Window, EYE_H, EYE_W};
use cairo::{Context, Operator, XCBConnection as CairoConn, XCBDrawable, XCBSurface, XCBVisualType};
use std::error::Error;
use std::sync::Arc;
use x11rb::connection::Connection;
use x11rb::xcb_ffi::XCBConnection as XConn;

/// The xcb layout of a visual, so cairo can be handed one (see <xcb/xproto.h>).
#[repr(C)]
pub struct XcbVisualType {
    visual_id: u32,
    class: u8,
    bits_per_rgb_value: u8,
    colormap_entries: u16,
    red_mask: u32,
    green_mask: u32,
    blue_mask: u32,
    pad0: [u8; 4],
}

pub enum Backend {
    Soft {
        scene: Box<Scene>,
        surface: XCBSurface,
        conn: Arc<XConn>,
        _visual: Box<XcbVisualType>,
    },
    #[cfg(feature = "gpu")]
    Gpu(crate::gpu::Renderer),
}

impl Backend {
    /// cairo straight into the window — the fallback and today's default.
    pub fn soft(win: &Window) -> Result<Self, Box<dyn Error>> {
        let (visual_id, v) = win.visual();
        let mut vt = Box::new(XcbVisualType {
            visual_id,
            class: u8::from(v.class),
            bits_per_rgb_value: v.bits_per_rgb_value,
            colormap_entries: v.colormap_entries,
            red_mask: v.red_mask,
            green_mask: v.green_mask,
            blue_mask: v.blue_mask,
            pad0: [0; 4],
        });
        let conn = win.conn().clone();
        // cairo draws straight into the window: x11rb owns the connection, cairo
        // only borrows the pointer and the visual, both outliving the surface.
        let surface = unsafe {
            let cconn = CairoConn::from_raw_none(conn.get_raw_xcb_connection() as *mut _);
            let cvis = XCBVisualType::from_raw_none(&mut *vt as *mut XcbVisualType as *mut _);
            XCBSurface::create(&cconn, &XCBDrawable(win.id), &cvis, EYE_W as i32, EYE_H as i32)?
        };
        Ok(Self::Soft { scene: Box::new(Scene::new()?), surface, conn, _visual: vt })
    }

    /// GL ES 3.0 on the same window, or an error saying why not.
    #[cfg(feature = "gpu")]
    pub fn gpu(win: &Window, sim: &Sim) -> Result<Self, Box<dyn Error>> {
        Ok(Self::Gpu(crate::gpu::Renderer::open(win, sim)?))
    }

    /// Which idle rate this backend defaults to.
    pub fn kind(&self) -> Kind {
        match self {
            Self::Soft { .. } => Kind::Soft,
            #[cfg(feature = "gpu")]
            Self::Gpu(_) => Kind::Gpu,
        }
    }

    /// The GPU failed after it had come up: cairo takes over the same window.
    pub fn demote(&mut self, win: &Window, why: &str) -> Result<(), Box<dyn Error>> {
        eprintln!("[eye-render] gpu failed at runtime: {why} — software");
        *self = Self::soft(win)?;
        Ok(())
    }

    /// What `ready` reports.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Soft { .. } => "software",
            #[cfg(feature = "gpu")]
            Self::Gpu(_) => "gpu",
        }
    }

    /// One frame, written to `path` instead of being left on the window —
    /// the offscreen side-by-side of the two backends.
    pub fn dump_png(&mut self, sim: &Sim, st: &mut State, frame: &Frame, now: u64, path: &str) -> Result<(), Box<dyn Error>> {
        match self {
            Self::Soft { scene, .. } => {
                scene.render(sim, st, frame, now)?;
                scene.frame().write_to_png(&mut std::fs::File::create(path)?)?;
                Ok(())
            }
            #[cfg(feature = "gpu")]
            Self::Gpu(r) => r.dump_png(sim, st, frame, now, path),
        }
    }

    /// One frame onto the window.
    pub fn paint(&mut self, sim: &Sim, st: &mut State, frame: &Frame, now: u64) -> Result<(), Box<dyn Error>> {
        match self {
            Self::Soft { scene, surface, conn, .. } => {
                let dirty = scene.render(sim, st, frame, now)?;
                let g = Context::new(&*surface)?;
                crate::eye::clip_rect(&g, dirty);
                g.set_operator(Operator::Source);
                g.set_source_surface(scene.frame(), 0.0, 0.0)?;
                g.paint()?;
                surface.flush();
                conn.flush()?;
                Ok(())
            }
            // an unmapped window has no back buffer worth presenting: the
            // display is off, and the `Expose` after the remap paints once
            #[cfg(feature = "gpu")]
            Self::Gpu(r) if !st.mapped => {
                r.full_damage();
                Ok(())
            }
            #[cfg(feature = "gpu")]
            Self::Gpu(r) => r.paint(sim, st, frame, now),
        }
    }
}
