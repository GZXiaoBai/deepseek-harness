use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};

fn verify_update(artifact: &[u8], encoded_signature: &str, encoded_public_key: &str) -> bool {
    let Ok(public_key_text) = STANDARD.decode(encoded_public_key.trim()) else {
        return false;
    };
    let Ok(public_key_text) = String::from_utf8(public_key_text) else {
        return false;
    };
    let Ok(signature_text) = STANDARD.decode(encoded_signature.trim()) else {
        return false;
    };
    let Ok(signature_text) = String::from_utf8(signature_text) else {
        return false;
    };
    let Ok(public_key) = PublicKey::decode(&public_key_text) else {
        return false;
    };
    let Ok(signature) = Signature::decode(&signature_text) else {
        return false;
    };
    public_key.verify(artifact, &signature, false).is_ok()
}

#[test]
fn packaged_update_accepts_the_artifact_and_rejects_tampering() {
    let inputs = [
        env::var("DSH_UPDATE_ARTIFACT"),
        env::var("DSH_UPDATE_SIGNATURE"),
        env::var("DSH_UPDATE_PUBLIC_KEY"),
    ];
    if inputs.iter().all(Result::is_err) {
        return;
    }
    let [Ok(artifact_path), Ok(signature_path), Ok(public_key)] = inputs else {
        panic!("all DSH_UPDATE_* variables are required for packaged signature verification");
    };
    let artifact = fs::read(artifact_path).expect("update artifact must be readable");
    let signature = fs::read_to_string(signature_path).expect("update signature must be readable");
    assert!(verify_update(&artifact, &signature, &public_key));

    let mut tampered = artifact;
    tampered.push(0);
    assert!(!verify_update(&tampered, &signature, &public_key));
}

#[test]
fn malformed_update_metadata_is_rejected() {
    assert!(!verify_update(b"artifact", "not-base64", "not-base64"));
}
