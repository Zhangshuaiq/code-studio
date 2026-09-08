package com.codestudio.tasks;

import java.util.Map;

public record TaskResult(boolean success, String message, Map<String, Object> summary) {
    public static TaskResult success(String message, Map<String, Object> summary) { return new TaskResult(true, message, summary); }
    public static TaskResult success(String message) { return success(message, Map.of()); }
    public static TaskResult failure(String message) { return new TaskResult(false, message, Map.of()); }
}
