use crate::node_manager::types::NodeType;

/// Node class definitions for Synergy Network
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeClass {
    ClassI = 1,
    ClassII = 2,
    ClassIII = 3,
    ClassIV = 4,
    ClassV = 5,
}

impl NodeClass {
    /// Get the address prefix for this node class
    pub fn address_prefix(&self) -> &'static str {
        match self {
            NodeClass::ClassI => "synv1",
            NodeClass::ClassII => "synv2",
            NodeClass::ClassIII => "synv3",
            NodeClass::ClassIV => "synv4",
            NodeClass::ClassV => "synv5",
        }
    }

    /// Get the class number
    pub fn class_number(&self) -> u8 {
        *self as u8
    }

    /// Get the staking requirement (in SNRG) for this node class
    pub fn staking_requirement(&self) -> u64 {
        5_000
    }

    /// Get the genesis allocation per node (in SNRG)
    pub fn genesis_allocation() -> u64 {
        100_000
    }

    /// Get node class from node type (per Synergy Network Node Whitepaper v1.0)
    pub fn from_node_type(node_type: &NodeType) -> Self {
        match node_type {
            // Class I — Consensus Nodes (Whitepaper types 1-4)
            NodeType::Validator => NodeClass::ClassI,
            NodeType::Committee => NodeClass::ClassI,
            NodeType::ArchiveValidator => NodeClass::ClassI,
            NodeType::AuditValidator => NodeClass::ClassI,

            // Class II — Interoperability Nodes (Whitepaper types 5-9)
            NodeType::Relayer => NodeClass::ClassII,
            NodeType::Witness => NodeClass::ClassII,
            NodeType::Oracle => NodeClass::ClassII,
            NodeType::UmaCoordinator => NodeClass::ClassII,
            NodeType::CrossChainVerifier => NodeClass::ClassII,

            // Class III — Intelligence & Computation Nodes (Whitepaper types 10-13)
            NodeType::Compute => NodeClass::ClassIII,
            NodeType::AiInference => NodeClass::ClassIII,
            NodeType::PqcCrypto => NodeClass::ClassIII,
            NodeType::DataAvailability => NodeClass::ClassIII,

            // Class IV — Governance & Treasury Nodes (Whitepaper types 14-16)
            NodeType::GovernanceAuditor => NodeClass::ClassIV,
            NodeType::TreasuryController => NodeClass::ClassIV,
            NodeType::SecurityCouncil => NodeClass::ClassIV,

            // Class V — Service & Support Nodes (Whitepaper types 17-19)
            NodeType::RpcGateway => NodeClass::ClassV,
            NodeType::Indexer => NodeClass::ClassV,
            NodeType::Observer => NodeClass::ClassV,
        }
    }

    /// Get description of this node class (per whitepaper)
    pub fn description(&self) -> &'static str {
        match self {
            NodeClass::ClassI => "Consensus Nodes — Secure the chain through PoSy consensus",
            NodeClass::ClassII => "Interoperability Nodes — Execute SXCP and UMA operations",
            NodeClass::ClassIII => {
                "Intelligence & Computation Nodes — Provide decentralized compute and AI services"
            }
            NodeClass::ClassIV => {
                "Governance & Treasury Nodes — Manage DAO proposals and treasury execution"
            }
            NodeClass::ClassV => "Service & Support Nodes — Operate ancillary infrastructure",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_address_prefixes() {
        assert_eq!(NodeClass::ClassI.address_prefix(), "synv1");
        assert_eq!(NodeClass::ClassII.address_prefix(), "synv2");
        assert_eq!(NodeClass::ClassIII.address_prefix(), "synv3");
        assert_eq!(NodeClass::ClassIV.address_prefix(), "synv4");
        assert_eq!(NodeClass::ClassV.address_prefix(), "synv5");
    }

    #[test]
    fn test_node_type_mapping() {
        // Class I — Consensus
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Validator),
            NodeClass::ClassI
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Committee),
            NodeClass::ClassI
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::ArchiveValidator),
            NodeClass::ClassI
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::AuditValidator),
            NodeClass::ClassI
        );
        // Class II — Interoperability
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Relayer),
            NodeClass::ClassII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Witness),
            NodeClass::ClassII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Oracle),
            NodeClass::ClassII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::UmaCoordinator),
            NodeClass::ClassII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::CrossChainVerifier),
            NodeClass::ClassII
        );
        // Class III — Intelligence & Computation
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Compute),
            NodeClass::ClassIII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::AiInference),
            NodeClass::ClassIII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::PqcCrypto),
            NodeClass::ClassIII
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::DataAvailability),
            NodeClass::ClassIII
        );
        // Class IV — Governance & Treasury
        assert_eq!(
            NodeClass::from_node_type(&NodeType::GovernanceAuditor),
            NodeClass::ClassIV
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::TreasuryController),
            NodeClass::ClassIV
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::SecurityCouncil),
            NodeClass::ClassIV
        );
        // Class V — Service & Support
        assert_eq!(
            NodeClass::from_node_type(&NodeType::RpcGateway),
            NodeClass::ClassV
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Indexer),
            NodeClass::ClassV
        );
        assert_eq!(
            NodeClass::from_node_type(&NodeType::Observer),
            NodeClass::ClassV
        );
    }

    #[test]
    fn test_staking_requirements() {
        assert_eq!(NodeClass::ClassI.staking_requirement(), 5_000);
        assert_eq!(NodeClass::ClassII.staking_requirement(), 5_000);
        assert_eq!(NodeClass::ClassIII.staking_requirement(), 5_000);
        assert_eq!(NodeClass::ClassIV.staking_requirement(), 5_000);
        assert_eq!(NodeClass::ClassV.staking_requirement(), 5_000);
    }

    #[test]
    fn test_genesis_allocation() {
        assert_eq!(NodeClass::genesis_allocation(), 100_000);
    }
}
