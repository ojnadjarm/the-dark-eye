//! The eye's renderer as a library: the simulation, the two backends and the
//! parity harness that proves they draw the same picture. `main.rs` is the
//! socket-driven binary on top of it.
pub mod atlas;
pub mod backend;
pub mod caption;
pub mod eye;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod orbit;
pub mod overlay;
#[cfg(feature = "gpu")]
pub mod parity;
pub mod rain;
pub mod sched;
pub mod sim;
pub mod window;
