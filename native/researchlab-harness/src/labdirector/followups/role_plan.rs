#![allow(unused_imports)]
use super::*;

// Split into parts, each a real submodule (see mod declarations below);
// the parts share this module's imports through `use super::*`.

#[path = "role_plan/role_plan_01.rs"]
mod role_plan_01;
pub(crate) use role_plan_01::*;
#[path = "role_plan/role_plan_02.rs"]
mod role_plan_02;
pub(crate) use role_plan_02::*;
