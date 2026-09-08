package com.codestudio.tasks;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("code-studio.tasks")
public class PlatformTaskProperties {
    private boolean enabled = true;
    private String platformUrl;
    private String applicationName;
    private String registrationToken;
    public boolean isEnabled() { return enabled; } public void setEnabled(boolean value) { enabled = value; }
    public String getPlatformUrl() { return platformUrl; } public void setPlatformUrl(String value) { platformUrl = value; }
    public String getApplicationName() { return applicationName; } public void setApplicationName(String value) { applicationName = value; }
    public String getRegistrationToken() { return registrationToken; } public void setRegistrationToken(String value) { registrationToken = value; }
}
