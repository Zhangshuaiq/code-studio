package com.codestudio.tasks;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.web.client.RestClient;
import java.util.Map;

@AutoConfiguration
@EnableConfigurationProperties(PlatformTaskProperties.class)
@ConditionalOnProperty(prefix="code-studio.tasks",name="enabled",havingValue="true",matchIfMissing=true)
public class PlatformTaskAutoConfiguration {
    @Bean PlatformTaskRegistry platformTaskRegistry(ApplicationContext context,ObjectMapper mapper){return new PlatformTaskRegistry(context,mapper);}
    @Bean PlatformTaskController platformTaskController(PlatformTaskRegistry registry,PlatformTaskProperties properties){return new PlatformTaskController(registry,properties);}
    @Bean ApplicationRunner platformTaskRegistration(PlatformTaskRegistry registry,PlatformTaskProperties properties){return args->{if(properties.getPlatformUrl()==null||properties.getApplicationName()==null||properties.getRegistrationToken()==null)return;RestClient.create().post().uri(properties.getPlatformUrl().replaceAll("/$","")+"/internal/java-tasks/register").header("X-Application-Name",properties.getApplicationName()).header("X-Registration-Token",properties.getRegistrationToken()).body(Map.of("version","0.1.0","handlers",registry.descriptors())).retrieve().toBodilessEntity();};}
}
