function required(name, value) {
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
export function loadConfig(env) {
    const synergyEnv = (env.SYNERGY_ENV || 'testnet');
    const defaultsByEnv = {
        'testnet': {
            coreRpc: 'https://testnet-core-rpc.synergy-network.io'
        },
        testnet: {
            coreRpc: 'https://testnet-core-rpc.synergy-network.io'
        },
        'mainnet-beta': {
            coreRpc: 'https://mainnet-beta-core-rpc.synergy-network.io'
        },
        mainnet: {
            coreRpc: 'https://mainnet-core-rpc.synergy-network.io'
        }
    };
    return {
        nodeEnv: env.NODE_ENV || 'development',
        host: env.HOST || '0.0.0.0',
        port: Number(env.PORT || 3020),
        corsOrigin: env.CORS_ORIGIN || '*',
        dbUrl: required('DATABASE_URL', env.DATABASE_URL),
        explorerResetToken: env.SYNERGY_EXPLORER_RESET_TOKEN,
        synergyEnv,
        synergyCoreRpcUrl: env.SYNERGY_CORE_RPC_URL || defaultsByEnv[synergyEnv].coreRpc,
        synergyCoreRpcFallbackUrl: env.SYNERGY_CORE_RPC_FALLBACK_URL || defaultsByEnv[synergyEnv].fallback,
    };
}
