package com.codestudio.tasks;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

@RestController
public class PlatformTaskController {
    private final PlatformTaskRegistry registry; private final PlatformTaskProperties properties;
    public PlatformTaskController(PlatformTaskRegistry registry, PlatformTaskProperties properties){this.registry=registry;this.properties=properties;}
    record ExecuteRequest(String executionId,String handler,Map<String,Object> parameters,Integer timeoutSeconds){}
    @PostMapping("/internal/platform-tasks/execute")
    public Object execute(@RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,@RequestHeader(value="X-Trace-Id",required=false) String traceId,@RequestBody ExecuteRequest request) throws Exception {
        String expected="Bearer "+properties.getRegistrationToken(); if(!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),authorization.getBytes(StandardCharsets.UTF_8)))throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        Object result=registry.invoke(request.handler(),request.parameters()==null?Map.of():request.parameters(),new TaskExecutionContext(request.executionId(),traceId));
        return result instanceof TaskResult ? result : TaskResult.success("执行成功",Map.of("result",result==null?"":result));
    }
}
