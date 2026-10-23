//! Core library of Terrain Tool. Parsers and writers for Arma 3 terrain files. No UI code.
/// Progress of a long job: it gets the part that is done (0 to 1) and returns false when the user cancels the job.
pub type Progress<'a> = &'a mut dyn FnMut(f64) -> bool;
/// Error text of a cancelled job.
pub const CANCELLED: &str = "cancelled";
pub mod alb;
pub mod asc;
pub mod cfg;
pub mod clutter;
pub mod fill;
pub mod game;
pub mod height;
pub mod layers_cfg;
pub mod mask;
pub mod objdb;
pub mod p3d;
pub mod paa;
pub mod project;
pub mod roads;
pub mod rvmat;
pub mod sat;
pub mod shp;
pub mod ter;
pub mod tiles;
pub mod tilestore;
pub mod wrp;
