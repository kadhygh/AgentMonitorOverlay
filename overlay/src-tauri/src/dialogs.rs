use crate::models::FolderPickResult;

#[cfg(windows)]
pub(crate) fn pick_workspace_directory() -> FolderPickResult {
    pick_windows_directory(DirectoryPickerKind::Workspace)
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum DirectoryPickerKind {
    Workspace,
}

#[cfg(windows)]
fn pick_windows_directory(kind: DirectoryPickerKind) -> FolderPickResult {
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{ERROR_CANCELLED, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
        FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    let cancelled_hresult = HRESULT::from_win32(ERROR_CANCELLED.0);

    unsafe {
        let init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let should_uninitialize = if init_result.is_ok() {
            true
        } else if init_result == RPC_E_CHANGED_MODE {
            false
        } else {
            return FolderPickResult {
                ok: false,
                cancelled: false,
                path: None,
                message: format!(
                    "Could not initialize Windows folder picker ({:?}).",
                    init_result
                ),
            };
        };

        let result = (|| -> windows::core::Result<String> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            match kind {
                DirectoryPickerKind::Workspace => {
                    dialog.SetTitle(windows::core::w!("Select workspace folder"))?
                }
            };
            dialog.SetOkButtonLabel(windows::core::w!("Choose"))?;
            dialog.SetOptions(
                FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR,
            )?;
            dialog.Show(None)?;

            let item = dialog.GetResult()?;
            let path_ptr = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = String::from_utf16_lossy(path_ptr.as_wide());
            CoTaskMemFree(Some(path_ptr.0 as *const core::ffi::c_void));
            Ok(path)
        })();

        if should_uninitialize {
            CoUninitialize();
        }

        match result {
            Ok(path) => FolderPickResult {
                ok: true,
                cancelled: false,
                path: Some(path.clone()),
                message: match kind {
                    DirectoryPickerKind::Workspace => format!("Selected workspace folder: {path}"),
                },
            },
            Err(error) if error.code() == cancelled_hresult => FolderPickResult {
                ok: false,
                cancelled: true,
                path: None,
                message: match kind {
                    DirectoryPickerKind::Workspace => {
                        "Workspace folder selection cancelled.".to_string()
                    }
                },
            },
            Err(error) => FolderPickResult {
                ok: false,
                cancelled: false,
                path: None,
                message: match kind {
                    DirectoryPickerKind::Workspace => {
                        format!("Could not select workspace folder: {error:?}")
                    }
                },
            },
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn pick_workspace_directory() -> FolderPickResult {
    FolderPickResult {
        ok: false,
        cancelled: false,
        path: None,
        message: "Folder selection is only implemented on Windows.".to_string(),
    }
}
