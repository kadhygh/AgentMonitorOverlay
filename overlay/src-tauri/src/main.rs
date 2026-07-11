#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_monitor_overlay_lib::run();
}
