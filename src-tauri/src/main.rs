// Hide the console window on Windows release builds (no Command Prompt).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    proteus_ap_ocr_lib::run()
}
