#include "core/config.hpp"
#include <cstdlib>
#include <fstream>
#include <stdexcept>

namespace zcode::core {

Config Config::loadFromEnvironment() {
    Config config;
    
    // Load from environment variables
    const char* provider = std::getenv("ZCODE_PROVIDER");
    const char* model = std::getenv("ZCODE_MODEL");
    const char* apiKey = std::getenv("ZCODE_API_KEY");
    const char* baseURL = std::getenv("ZCODE_BASE_URL");
    const char* workDir = std::getenv("ZCODE_WORK_DIR");
    
    if (!provider || !apiKey) {
        throw std::runtime_error("ZCODE_PROVIDER and ZCODE_API_KEY environment variables are required");
    }
    
    config.providerConfig.type = (std::string(provider) == "anthropic") 
        ? ProviderType::Anthropic 
        : ProviderType::OpenAI;
    config.providerConfig.apiKey = apiKey;
    
    if (model) config.providerConfig.model = model;
    if (baseURL) config.providerConfig.baseURL = baseURL;
    if (workDir) config.workingDir = workDir;
    else config.workingDir = ".";
    
    return config;
}

Config Config::loadFromFile(const std::string& filePath) {
    std::ifstream file(filePath);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open config file: " + filePath);
    }
    
    // TODO: Parse JSON when nlohmann/json is available
    return Config();
}

} // namespace zcode::core
