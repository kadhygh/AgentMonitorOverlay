use crate::models::{ModelCredentialResult, ModelCredentialStatus};
use std::ffi::c_void;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

const TARGET_PREFIX: &str = "AgentMonitorOverlay/model-provider/";
const SUPPORTED_PROVIDERS: [&str; 2] = ["deepseek-v4", "glm-5.2"];

fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    let supported = SUPPORTED_PROVIDERS.contains(&provider_id);
    #[cfg(test)]
    let supported = supported || provider_id == "amo-credential-test";

    if supported {
        Ok(())
    } else {
        Err(format!("Unsupported model provider: {provider_id}"))
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn target_name(provider_id: &str) -> String {
    format!("{TARGET_PREFIX}{provider_id}")
}

fn credential_exists(provider_id: &str) -> Result<bool, String> {
    validate_provider_id(provider_id)?;
    let target = wide(&target_name(provider_id));
    let mut credential_ptr: *mut CREDENTIALW = null_mut();
    let read_ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };
    if read_ok == 0 {
        let error = unsafe { GetLastError() };
        return if error == ERROR_NOT_FOUND {
            Ok(false)
        } else {
            Err(format!("Windows Credential Manager read failed ({error})."))
        };
    }

    if !credential_ptr.is_null() {
        unsafe { CredFree(credential_ptr.cast::<c_void>()) };
    }
    Ok(true)
}

fn read_credential(provider_id: &str) -> Result<Option<String>, String> {
    validate_provider_id(provider_id)?;
    let target = wide(&target_name(provider_id));
    let mut credential_ptr: *mut CREDENTIALW = null_mut();
    let read_ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };
    if read_ok == 0 {
        let error = unsafe { GetLastError() };
        return if error == ERROR_NOT_FOUND {
            Ok(None)
        } else {
            Err(format!("Windows Credential Manager read failed ({error})."))
        };
    }

    if credential_ptr.is_null() {
        return Err("Windows Credential Manager returned an empty credential.".to_string());
    }

    let result = unsafe {
        let credential = &*credential_ptr;
        if credential.CredentialBlobSize == 0 || credential.CredentialBlob.is_null() {
            CredFree(credential_ptr.cast::<c_void>());
            return Err("Stored provider credential is empty.".to_string());
        }
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(bytes.to_vec())
            .map(Some)
            .map_err(|_| "Stored provider credential is not valid UTF-8.".to_string())
    };
    unsafe { CredFree(credential_ptr.cast::<c_void>()) };
    result
}

pub(crate) fn credential_status(provider_ids: Vec<String>) -> ModelCredentialStatus {
    let mut configured_provider_ids = Vec::new();
    for provider_id in provider_ids {
        match credential_exists(&provider_id) {
            Ok(true) => configured_provider_ids.push(provider_id),
            Ok(false) => {}
            Err(message) => {
                return ModelCredentialStatus {
                    ok: false,
                    configured_provider_ids,
                    message,
                };
            }
        }
    }

    ModelCredentialStatus {
        ok: true,
        configured_provider_ids,
        message: "Model credential status loaded from Windows Credential Manager.".to_string(),
    }
}

pub(crate) fn save_credential(provider_id: String, api_key: String) -> ModelCredentialResult {
    if let Err(message) = validate_provider_id(&provider_id) {
        return ModelCredentialResult::error(provider_id, message);
    }
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return ModelCredentialResult::error(provider_id, "API key cannot be empty.".to_string());
    }

    let mut target = wide(&target_name(&provider_id));
    let mut comment = wide("AMO model provider API key");
    let mut username = wide("AMO");
    let mut credential_blob = trimmed.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        Comment: comment.as_mut_ptr(),
        LastWritten: FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        },
        CredentialBlobSize: credential_blob.len() as u32,
        CredentialBlob: credential_blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: null_mut(),
        TargetAlias: null_mut(),
        UserName: username.as_mut_ptr(),
    };

    let write_ok = unsafe { CredWriteW(&credential, 0) };
    credential_blob.fill(0);
    if write_ok == 0 {
        let error = unsafe { GetLastError() };
        return ModelCredentialResult::error(
            provider_id,
            format!("Windows Credential Manager write failed ({error})."),
        );
    }

    ModelCredentialResult::success(provider_id, true, "API key saved securely.".to_string())
}

pub(crate) fn delete_credential(provider_id: String) -> ModelCredentialResult {
    if let Err(message) = validate_provider_id(&provider_id) {
        return ModelCredentialResult::error(provider_id, message);
    }
    let target = wide(&target_name(&provider_id));
    let delete_ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if delete_ok == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_NOT_FOUND {
            return ModelCredentialResult::error(
                provider_id,
                format!("Windows Credential Manager delete failed ({error})."),
            );
        }
    }

    ModelCredentialResult::success(provider_id, false, "Stored API key removed.".to_string())
}

pub(crate) fn resolve_credential(provider_id: String) -> ModelCredentialResult {
    match read_credential(&provider_id) {
        Ok(Some(api_key)) => ModelCredentialResult {
            ok: true,
            provider_id,
            configured: true,
            api_key: Some(api_key),
            message: "Stored API key resolved for launch.".to_string(),
        },
        Ok(None) => ModelCredentialResult::error(
            provider_id,
            "No stored API key exists for this provider.".to_string(),
        ),
        Err(message) => ModelCredentialResult::error(provider_id, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_targets_are_provider_scoped() {
        assert_eq!(
            target_name("deepseek-v4"),
            "AgentMonitorOverlay/model-provider/deepseek-v4"
        );
    }

    #[test]
    fn unsupported_providers_are_rejected() {
        assert!(validate_provider_id("custom").is_err());
    }

    #[test]
    fn credential_round_trip_uses_windows_credential_manager() {
        let provider_id = "amo-credential-test".to_string();
        let _ = delete_credential(provider_id.clone());

        let saved = save_credential(provider_id.clone(), "temporary-test-key".to_string());
        assert!(saved.ok, "{}", saved.message);
        assert!(credential_exists(&provider_id).unwrap());

        let resolved = resolve_credential(provider_id.clone());
        assert!(resolved.ok, "{}", resolved.message);
        assert_eq!(resolved.api_key.as_deref(), Some("temporary-test-key"));

        let deleted = delete_credential(provider_id.clone());
        assert!(deleted.ok, "{}", deleted.message);
        assert!(!credential_exists(&provider_id).unwrap());
    }
}
