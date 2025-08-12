const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

/**
 * Google Secret Manager client for retrieving secrets
 */
class SecretManagerClient {
    constructor(projectId) {
        this.projectId = projectId;
        this.client = new SecretManagerServiceClient();
        this.cache = new Map();
        
        console.log(`🔐 Secret Manager client initialized for project: ${projectId}`);
    }
    
    /**
     * Get secret value from Google Secret Manager
     * @param {string} secretName - Name of the secret
     * @param {string} version - Version of the secret (default: 'latest')
     * @returns {string} Secret value
     */
    async getSecret(secretName, version = 'latest') {
        const cacheKey = `${secretName}:${version}`;
        
        // Return cached value if available
        if (this.cache.has(cacheKey)) {
            console.log(`🔐 Using cached secret: ${secretName}`);
            return this.cache.get(cacheKey);
        }
        
        try {
            console.log(`🔐 Retrieving secret: ${secretName}`);
            
            const name = `projects/${this.projectId}/secrets/${secretName}/versions/${version}`;
            const [response] = await this.client.accessSecretVersion({ name });
            
            const secretValue = response.payload.data.toString();
            
            // Cache the secret value
            this.cache.set(cacheKey, secretValue);
            
            console.log(`✅ Secret retrieved: ${secretName}`);
            return secretValue;
            
        } catch (error) {
            console.error(`❌ Failed to retrieve secret ${secretName}:`, error.message);
            throw new Error(`Failed to retrieve secret ${secretName}: ${error.message}`);
        }
    }
    
    /**
     * Get multiple secrets at once
     * @param {Array<string>} secretNames - Array of secret names
     * @returns {Object} Object with secret names as keys and values as values
     */
    async getSecrets(secretNames) {
        console.log(`🔐 Retrieving ${secretNames.length} secrets...`);
        
        const secrets = {};
        const promises = secretNames.map(async (secretName) => {
            try {
                secrets[secretName] = await this.getSecret(secretName);
            } catch (error) {
                console.error(`❌ Failed to retrieve ${secretName}:`, error.message);
                throw error;
            }
        });
        
        await Promise.all(promises);
        
        console.log(`✅ Retrieved all ${secretNames.length} secrets`);
        return secrets;
    }
    
    /**
     * Initialize configuration from secrets
     * @returns {Object} Configuration object with all required values
     */
    async initializeConfig() {
        console.log('🔐 Initializing configuration from Secret Manager...');
        
        const secretNames = [
            'tradestation-refresh-token',
            'mailgun-api-key',
            'mailgun-domain',
            'email-to',
            'email-from'
        ];
        
        try {
            const secrets = await this.getSecrets(secretNames);
            
            const config = {
                projectId: this.projectId,
                dataset: process.env.BIGQUERY_DATASET || 'spx_trading',
                mailgunApiKey: secrets['mailgun-api-key'],
                mailgunDomain: secrets['mailgun-domain'],
                emailTo: secrets['email-to'],
                emailFrom: secrets['email-from'],
                tradestationRefreshToken: secrets['tradestation-refresh-token'],
                version: process.env.CLOUD_FUNCTION_VERSION || '1.0.0'
            };
            
            console.log('✅ Configuration initialized from Secret Manager');
            return config;
            
        } catch (error) {
            console.error('❌ Failed to initialize configuration:', error.message);
            throw error;
        }
    }
    
    /**
     * Validate that all required secrets exist
     * @returns {boolean} True if all secrets are accessible
     */
    async validateSecrets() {
        console.log('🔍 Validating Secret Manager access...');
        
        const requiredSecrets = [
            'tradestation-refresh-token',
            'mailgun-api-key',
            'mailgun-domain',
            'email-to',
            'email-from'
        ];
        
        try {
            for (const secretName of requiredSecrets) {
                await this.getSecret(secretName);
                console.log(`✅ ${secretName}: accessible`);
            }
            
            console.log('✅ All required secrets are accessible');
            return true;
            
        } catch (error) {
            console.error('❌ Secret validation failed:', error.message);
            return false;
        }
    }
}

module.exports = { SecretManagerClient };