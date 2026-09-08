package com.codestudio.tasks;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface PlatformTask {
    String name();
    String description() default "";
    String riskLevel() default "medium";
    int timeoutSeconds() default 300;
    boolean allowConcurrent() default false;
    boolean idempotent() default false;
}
