//! The gate: the software frame and the GL frame of the same seeded scene are
//! the same picture, region by region. Skipped, not failed, where Mesa is not
//! installed — everywhere it is, this must run.
#![cfg(feature = "gpu")]
use eye_render::parity::{self, Outcome};

#[test]
fn parity_the_two_backends_draw_the_same_scenes() {
    let dir = parity::out_dir();
    match parity::run(&dir, None).expect("parity run") {
        Outcome::NoEgl(why) => println!("parity: no EGL — skipped ({why})"),
        Outcome::Ran(rows) => {
            print!("{}", parity::table(&rows));
            println!("{}/parity.md", dir.display());
            assert_eq!(rows.len(), parity::scene_names().len(), "every scene was compared");
            let bad = parity::failures(&rows);
            assert!(bad.is_empty(), "below the gate: {}", bad.join("; "));
        }
    }
}
