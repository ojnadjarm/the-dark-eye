//! `parity [--scene <name>] [--out <dir>]` — the harness by hand, when a human
//! wants the PNGs and the table without running the test suite.
use eye_render::parity::{self, Outcome};
use std::error::Error;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let dir = arg("--out").map_or_else(parity::out_dir, PathBuf::from);
    let scene = arg("--scene");
    match parity::run(&dir, scene.as_deref())? {
        Outcome::NoEgl(why) => {
            eprintln!("parity: no EGL — skipped ({why})");
            Ok(())
        }
        Outcome::Ran(rows) => {
            print!("{}", parity::table(&rows));
            println!("\n{} written", dir.display());
            let bad = parity::failures(&rows);
            for f in &bad {
                eprintln!("parity: {f}");
            }
            if bad.is_empty() {
                Ok(())
            } else {
                Err(format!("{} region(s) below their gate", bad.len()).into())
            }
        }
    }
}
