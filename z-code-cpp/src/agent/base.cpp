#include "agent/base.hpp"

namespace zcode::agent {

Agent::Agent(
    const zcode::core::AgentConfig& config,
    const zcode::core::ProviderConfig& providerConfig
) : config(config), providerConfig(providerConfig) {
}

Agent::~Agent() = default;

void Agent::run(
    const std::string& userMessage,
    const std::vector<zcode::core::Message>& history,
    const std::string& workingDir,
    EventCallback onEvent
) {
    // TODO: Implement agent loop
    // 1. Call model with tools
    // 2. Stream events via onEvent callback
    // 3. Handle tool calls
    // 4. Loop until completion
}

void Agent::abort() {
    aborted = true;
}

void Agent::executeStep(
    const std::vector<zcode::core::Message>& messages,
    const std::string& workingDir,
    EventCallback onEvent
) {
    // TODO: Implement single step execution
}

} // namespace zcode::agent
