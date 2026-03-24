#pragma once

#include "types.hpp"
#include <string>
#include <vector>

namespace zcode::core {

class Config {
public:
    /**
     * Load configuration from:
     * 1. Environment variables (ZCODE_PROVIDER, ZCODE_MODEL, ZCODE_API_KEY, ZCODE_BASE_URL)
     * 2. CLI arguments
     * 3. .zcode.json file
     */
    static Config loadFromEnvironment();
    static Config loadFromFile(const std::string& filePath);

    // Getters
    ProviderConfig getProviderConfig() const { return providerConfig; }
    std::vector<AgentConfig> getAgentConfigs() const { return agentConfigs; }
    std::string getWorkingDirectory() const { return workingDir; }

    // Setters
    void setProviderConfig(const ProviderConfig& config) { providerConfig = config; }
    void setWorkingDirectory(const std::string& dir) { workingDir = dir; }

private:
    ProviderConfig providerConfig;
    std::vector<AgentConfig> agentConfigs;
    std::string workingDir;
};

} // namespace zcode::core
