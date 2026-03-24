#pragma once

#include <string>
#include <vector>
#include <map>
#include <optional>

namespace zcode::core {

// ─── Provider ───────────────────────────────────────────────────────────────

enum class ProviderType {
    OpenAI,
    Anthropic
};

struct ProviderConfig {
    ProviderType type;
    std::string apiKey;
    std::optional<std::string> baseURL;
    std::optional<std::string> model;
};

struct ProviderOptions {
    std::optional<float> temperature;
    std::optional<int> maxTokens;
    std::optional<std::string> systemPrompt;
};

// ─── Messages ────────────────────────────────────────────────────────────────

struct ToolUseBlock {
    std::string toolName;
    std::optional<std::string> toolCallId;
    std::optional<std::string> input;
    std::optional<std::string> output;
    bool isExpanded = false;
    enum class Status { Running, Done, Error } status = Status::Done;
    std::optional<long> duration; // milliseconds
};

enum class MessageRole { User, Assistant, System };

struct Message {
    MessageRole role;
    std::string content;
    std::optional<long> timestamp;
    std::vector<ToolUseBlock> toolUse;
    bool isError = false;
    std::optional<std::string> thinking; // Extended thinking/reasoning text
};

// ─── Agent Events ────────────────────────────────────────────────────────────

struct TokenUsage {
    int promptTokens;
    int completionTokens;
    int totalTokens;
};

struct PermissionRequest {
    std::string toolName;
    std::map<std::string, std::string> args;
};

enum class AgentEventType {
    TextDelta,
    ThinkingDelta,
    ToolCallStart,
    ToolCallResult,
    StepFinish,
    Finish,
    Error,
    PermissionRequest
};

struct AgentEvent {
    AgentEventType type;
    
    // TextDelta, ThinkingDelta, Error
    std::optional<std::string> text;
    
    // ToolCallStart
    std::optional<std::string> toolCallId;
    std::optional<std::string> toolName;
    std::optional<std::map<std::string, std::string>> args;
    
    // ToolCallResult
    std::optional<std::string> result;
    std::optional<long> duration;
    
    // StepFinish
    std::optional<TokenUsage> stepTokens;
    
    // Finish
    std::optional<TokenUsage> usage;
    std::optional<std::string> finishReason;
    
    // PermissionRequest
    std::optional<PermissionRequest> permissionRequest;
};

// ─── Tools ──────────────────────────────────────────────────────────────────

struct ToolResult {
    bool success;
    std::optional<std::string> output;
    std::optional<std::string> error;
};

// ─── Agent ──────────────────────────────────────────────────────────────────

enum class AgentName { Code, Plan, Review };
enum class ThinkingMode { Off, Light, Deep, Max };

struct PermissionRuleset {
    bool allowRead = true;
    bool allowWrite = false;
    bool allowExecute = false;
    bool allowNetwork = false;
};

struct AgentConfig {
    AgentName name;
    std::string displayName;
    std::string description;
    std::string systemPrompt;
    std::optional<float> temperature;
    std::optional<int> maxTokens;
    std::optional<int> maxSteps;
    PermissionRuleset permissions;
};

// ─── Session ────────────────────────────────────────────────────────────────

struct SessionState {
    std::vector<Message> messages;
    AgentName currentAgent;
    ProviderType currentProvider;
    std::string currentModel;
    ThinkingMode thinkingMode = ThinkingMode::Off;
    int thinkingBudget = 0;
};

} // namespace zcode::core
