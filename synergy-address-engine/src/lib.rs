// ============================================================================
// Synergy Network Address Generation Engine Library
// Supports all 35+ address types - Uses FN-DSA-1024 (NIST Level 5)
// ============================================================================

use base64::{engine::general_purpose, Engine as _};
use bech32::{FromBase32, ToBase32, Variant};
use chrono::Utc;
use pqcrypto_falcon::falcon1024;
use pqcrypto_traits::sign::{PublicKey as _, SecretKey as _};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};

// ADDRESS TYPE DEFINITIONS (35+ types)
#[derive(Debug, Clone, Copy)]
pub enum AddressType {
    WalletPrimary,
    WalletUtility,
    WalletAccount,
    WalletSmart,
    TransactionStandard,
    TransactionCrossChain,
    TransactionInternal,
    TokenFungible,
    TokenNonFungibleT1,
    TokenNonFungibleT2,
    TokenMultiAsset,
    TokenIdentity,
    ContractSystem,
    ContractCustom,
    NodeClass1,
    NodeClass2,
    NodeClass3,
    NodeClass4,
    NodeClass5,
    ClusterGroup1,
    ClusterGroup2,
    ClusterGroup3,
    ClusterGroup4,
    ClusterGroup5,
    DaoProposal,
    DaoOversight,
    DaoCommittee,
    MultisigGeneral,
    MultisigTreasury,
    MultisigValidator,
    FeeCollector,
    BurnAddress,
    ReservedE,
    ReservedI,
    ReservedP,
}

impl AddressType {
    pub fn prefix(&self) -> &'static str {
        match self {
            AddressType::WalletPrimary => "syns",
            AddressType::WalletUtility => "synu",
            AddressType::WalletAccount => "syna",
            AddressType::WalletSmart => "synz",
            AddressType::TransactionStandard => "synstxn",
            AddressType::TransactionCrossChain => "synxtxn",
            AddressType::TransactionInternal => "synitxn",
            AddressType::TokenFungible => "synb",
            AddressType::TokenNonFungibleT1 => "synn1",
            AddressType::TokenNonFungibleT2 => "synn2",
            AddressType::TokenMultiAsset => "synj",
            AddressType::TokenIdentity => "synk",
            AddressType::ContractSystem => "synq",
            AddressType::ContractCustom => "sync",
            AddressType::NodeClass1 => "synv1",
            AddressType::NodeClass2 => "synv2",
            AddressType::NodeClass3 => "synv3",
            AddressType::NodeClass4 => "synv4",
            AddressType::NodeClass5 => "synv5",
            AddressType::ClusterGroup1 => "syngrp1",
            AddressType::ClusterGroup2 => "syngrp2",
            AddressType::ClusterGroup3 => "syngrp3",
            AddressType::ClusterGroup4 => "syngrp4",
            AddressType::ClusterGroup5 => "syngrp5",
            AddressType::DaoProposal => "syndao",
            AddressType::DaoOversight => "syno",
            AddressType::DaoCommittee => "syny",
            AddressType::MultisigGeneral => "synm",
            AddressType::MultisigTreasury => "synw",
            AddressType::MultisigValidator => "synl",
            AddressType::FeeCollector => "synf",
            AddressType::BurnAddress => "synr",
            AddressType::ReservedE => "syne",
            AddressType::ReservedI => "syni",
            AddressType::ReservedP => "synp",
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct SynergyIdentity {
    pub address: String,
    pub public_key: String,
    pub private_key: String,
    pub address_type: String,
    pub algorithm: String,
    pub created_at: String,
}

/// Derives address from FN-DSA-1024 public key
/// Process: SHA3-256(public_key) -> First 20 bytes -> Bech32m
pub fn derive_address(public_key: &[u8], address_type: AddressType) -> Result<String, String> {
    let mut hasher = Sha3_256::new();
    hasher.update(public_key);
    let hash = hasher.finalize();
    let payload = &hash[..20];
    bech32::encode(address_type.prefix(), payload.to_base32(), Variant::Bech32m)
        .map_err(|e| format!("Failed to encode: {}", e))
}

pub fn generate_identity(address_type: AddressType) -> Result<SynergyIdentity, String> {
    if matches!(address_type, AddressType::BurnAddress) {
        return Ok(SynergyIdentity {
            address: "synr000000burn000000that000000coin".to_string(),
            public_key: String::new(),
            private_key: String::new(),
            address_type: "Burn Address".to_string(),
            algorithm: "FN-DSA-1024".to_string(),
            created_at: Utc::now().to_rfc3339(),
        });
    }
    let (pk, sk) = falcon1024::keypair();
    let public_b64 = general_purpose::STANDARD.encode(pk.as_bytes());
    let private_b64 = general_purpose::STANDARD.encode(sk.as_bytes());
    let address = derive_address(pk.as_bytes(), address_type)?;
    Ok(SynergyIdentity {
        address,
        public_key: public_b64,
        private_key: private_b64,
        address_type: format!("{:?}", address_type),
        algorithm: "FN-DSA-1024".to_string(),
        created_at: Utc::now().to_rfc3339(),
    })
}

pub fn verify_address(address: &str, public_key_b64: &str) -> Result<bool, String> {
    let pk_bytes = general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("Decode error: {}", e))?;
    let (_, data, _) = bech32::decode(address).map_err(|e| format!("Bech32 error: {}", e))?;
    let payload = Vec::<u8>::from_base32(&data).map_err(|e| format!("Base32 error: {}", e))?;
    let mut hasher = Sha3_256::new();
    hasher.update(&pk_bytes);
    let hash = hasher.finalize();
    Ok(payload == &hash[..20])
}
