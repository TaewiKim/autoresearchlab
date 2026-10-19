#![allow(unused_imports)]
use super::*;

// Split into parts, each a real submodule (see mod declarations below);
// the parts share this module's imports through `use super::*`.

#[path = "dependency_gates/dependency_gates_01.rs"]
mod dependency_gates_01;
pub(crate) use dependency_gates_01::*;
#[path = "dependency_gates/dependency_gates_02.rs"]
mod dependency_gates_02;
pub(crate) use dependency_gates_02::*;
