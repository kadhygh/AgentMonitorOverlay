use crate::models::OpenPathResult;

#[cfg(windows)]
pub(crate) fn write_text_to_clipboard(text: &str) -> OpenPathResult {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    let clipboard_text = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    let mut wide_text = clipboard_text.encode_utf16().collect::<Vec<u16>>();
    wide_text.push(0);
    let byte_len = wide_text.len() * std::mem::size_of::<u16>();

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return OpenPathResult {
                ok: false,
                message: "Could not open Windows clipboard.".to_string(),
            };
        }

        if EmptyClipboard() == 0 {
            CloseClipboard();
            return OpenPathResult {
                ok: false,
                message: "Could not clear Windows clipboard.".to_string(),
            };
        }

        let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if handle.is_null() {
            CloseClipboard();
            return OpenPathResult {
                ok: false,
                message: "Could not allocate clipboard memory.".to_string(),
            };
        }

        let locked = GlobalLock(handle) as *mut u16;
        if locked.is_null() {
            GlobalFree(handle);
            CloseClipboard();
            return OpenPathResult {
                ok: false,
                message: "Could not lock clipboard memory.".to_string(),
            };
        }

        std::ptr::copy_nonoverlapping(wide_text.as_ptr(), locked, wide_text.len());
        GlobalUnlock(handle);

        if SetClipboardData(CF_UNICODETEXT as u32, handle).is_null() {
            GlobalFree(handle);
            CloseClipboard();
            return OpenPathResult {
                ok: false,
                message: "Could not write text to Windows clipboard.".to_string(),
            };
        }

        CloseClipboard();
    }

    OpenPathResult {
        ok: true,
        message: "Copied pending prompt to clipboard.".to_string(),
    }
}

#[cfg(not(windows))]
pub(crate) fn write_text_to_clipboard(_text: &str) -> OpenPathResult {
    OpenPathResult {
        ok: false,
        message: "Clipboard writing is only implemented on Windows.".to_string(),
    }
}
