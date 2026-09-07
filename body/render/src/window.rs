//! The overlay window: a 32-bit ARGB, override-redirect, click-through X11
//! window bottom-right of the TV, and its cairo surface.
use serde::Serialize;
use std::error::Error;
use std::sync::Arc;
use x11rb::connection::Connection;
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::shape::SK;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::*;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::xcb_ffi::XCBConnection as XConn;

pub const EYE_W: u16 = 340;
pub const EYE_H: u16 = 380;
pub const MARGIN: i32 = 16;

/// A monitor as RandR reports it, and as `outputs` sends it to main.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Output {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Bottom-right minus the margin on the largest output, as `main.js:tvDisplay()`.
pub fn place(outputs: &[Output], x_offset: i32) -> (i16, i16) {
    let Some(tv) = outputs.iter().max_by_key(|o| o.w as u64 * o.h as u64) else {
        return (MARGIN as i16 + x_offset as i16, MARGIN as i16);
    };
    let x = tv.x + tv.w as i32 - EYE_W as i32 - MARGIN + x_offset;
    let y = tv.y + tv.h as i32 - EYE_H as i32 - MARGIN;
    (x as i16, y as i16)
}

pub struct Window {
    conn: Arc<XConn>,
    pub id: Window32,
    pub x: i16,
    pub y: i16,
    visual_id: u32,
    visual: Visualtype,
}

pub type Window32 = u32;

/// The 32-bit TrueColor visual of a screen — without it there is no alpha.
fn argb_visual(screen: &Screen) -> Option<(u32, Visualtype)> {
    screen
        .allowed_depths
        .iter()
        .filter(|d| d.depth == 32)
        .flat_map(|d| d.visuals.iter())
        .find(|v| v.class == VisualClass::TRUE_COLOR)
        .map(|v| (v.visual_id, v.clone()))
}

impl Window {
    /// Create the window, map it, make it click-through and always on top.
    pub fn open(conn: Arc<XConn>, screen_num: usize, outputs: &[Output], x_offset: i32) -> Result<Self, Box<dyn Error>> {
        let screen = &conn.setup().roots[screen_num].clone();
        let root = screen.root;
        let (visual_id, visual) = argb_visual(screen).ok_or("no 32-bit TrueColor visual on this screen")?;
        let (x, y) = place(outputs, x_offset);

        let cmap = conn.generate_id()?;
        conn.create_colormap(ColormapAlloc::NONE, cmap, root, visual_id)?;
        let id = conn.generate_id()?;
        let aux = CreateWindowAux::new()
            .background_pixel(0)
            .border_pixel(0)
            .colormap(cmap)
            .override_redirect(1)
            .event_mask(EventMask::STRUCTURE_NOTIFY | EventMask::EXPOSURE);
        conn.create_window(32, id, root, x, y, EYE_W, EYE_H, 0, WindowClass::INPUT_OUTPUT, visual_id, &aux)?;

        let atom = |n: &str| -> Result<u32, Box<dyn Error>> { Ok(conn.intern_atom(false, n.as_bytes())?.reply()?.atom) };
        let utf8 = atom("UTF8_STRING")?;
        let net_name = atom("_NET_WM_NAME")?;
        conn.change_property8(PropMode::REPLACE, id, u32::from(AtomEnum::WM_NAME), u32::from(AtomEnum::STRING), b"dark-eye-eye")?;
        conn.change_property8(PropMode::REPLACE, id, net_name, utf8, b"dark-eye-eye")?;
        conn.change_property8(PropMode::REPLACE, id, u32::from(AtomEnum::WM_CLASS), u32::from(AtomEnum::STRING), b"eye-render\0eye-render\0")?;
        let state = [atom("_NET_WM_STATE_ABOVE")?, atom("_NET_WM_STATE_STICKY")?, atom("_NET_WM_STATE_SKIP_TASKBAR")?];
        conn.change_property32(PropMode::REPLACE, id, atom("_NET_WM_STATE")?, u32::from(AtomEnum::ATOM), &state)?;

        // click-through: an empty input shape sends every pointer event below
        conn.xfixes_query_version(5, 0)?.reply()?;
        let region = conn.generate_id()?;
        conn.xfixes_create_region(region, &[])?;
        conn.xfixes_set_window_shape_region(id, SK::INPUT, 0, 0, region)?;
        conn.xfixes_destroy_region(region)?;

        conn.map_window(id)?;
        conn.configure_window(id, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE))?;
        conn.flush()?;

        Ok(Self { conn, id, x, y, visual_id, visual })
    }

    /// The 32-bit visual the window was created with — the backend needs it to
    /// build a cairo surface or to match an EGL config.
    pub fn visual(&self) -> (u32, &Visualtype) {
        (self.visual_id, &self.visual)
    }

    pub fn conn(&self) -> &Arc<XConn> {
        &self.conn
    }

    /// Move to where the outputs say the eye belongs now.
    pub fn replace_at(&mut self, outputs: &[Output], x_offset: i32) -> Result<(), Box<dyn Error>> {
        let (x, y) = place(outputs, x_offset);
        if (x, y) == (self.x, self.y) {
            return Ok(());
        }
        self.x = x;
        self.y = y;
        self.conn.configure_window(self.id, &ConfigureWindowAux::new().x(x as i32).y(y as i32))?;
        self.conn.flush()?;
        Ok(())
    }

    pub fn set_mapped(&self, on: bool) -> Result<(), Box<dyn Error>> {
        if on {
            self.conn.map_window(self.id)?;
            self.conn.configure_window(self.id, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE))?;
        } else {
            self.conn.unmap_window(self.id)?;
        }
        self.conn.flush()?;
        Ok(())
    }
}

/// Every RandR output that has a CRTC, largest first is the caller's business.
pub fn outputs(conn: &XConn, root: u32) -> Result<Vec<Output>, Box<dyn Error>> {
    let res = conn.randr_get_screen_resources_current(root)?.reply()?;
    let mut out = Vec::new();
    for o in res.outputs.iter().copied() {
        let info = match conn.randr_get_output_info(o, res.config_timestamp)?.reply() {
            Ok(i) => i,
            Err(_) => continue,
        };
        if info.crtc == 0 {
            continue;
        }
        let Ok(c) = conn.randr_get_crtc_info(info.crtc, res.config_timestamp)?.reply() else {
            continue;
        };
        if c.width == 0 || c.height == 0 {
            continue;
        }
        out.push(Output {
            name: String::from_utf8_lossy(&info.name).to_string(),
            x: c.x as i32,
            y: c.y as i32,
            w: c.width as u32,
            h: c.height as u32,
        });
    }
    Ok(out)
}

/// Ask for `RRScreenChangeNotify` on the root — the eye follows the monitors.
pub fn watch_outputs(conn: &XConn, root: u32) -> Result<(), Box<dyn Error>> {
    conn.randr_query_version(1, 5)?.reply()?;
    conn.randr_select_input(root, randr::NotifyMask::SCREEN_CHANGE)?;
    conn.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(name: &str, x: i32, y: i32, w: u32, h: u32) -> Output {
        Output { name: name.into(), x, y, w, h }
    }

    #[test]
    fn the_eye_sits_bottom_right_of_the_largest_output() {
        let lid_closed = vec![out("XWAYLAND0", 0, 0, 1366, 768)];
        assert_eq!(place(&lid_closed, 0), (1010, 372));
        let mirrored = vec![out("XWAYLAND0", 0, 0, 1920, 1080)];
        assert_eq!(place(&mirrored, 0), (1564, 684));
        let two = vec![out("XWAYLAND0", 0, 0, 1366, 768), out("XWAYLAND1", 1366, 0, 1920, 1080)];
        assert_eq!(place(&two, 0), (1366 + 1564, 684), "the largest one, at its own origin");
    }

    #[test]
    fn the_x_offset_shifts_the_window_and_no_output_still_gives_a_place() {
        let one = vec![out("XWAYLAND0", 0, 0, 1366, 768)];
        assert_eq!(place(&one, -360), (650, 372));
        assert_eq!(place(&[], 0), (16, 16));
    }
}
