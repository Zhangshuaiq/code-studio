package com.codestudio.tasks;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.context.ApplicationContext;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.util.ReflectionUtils;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class PlatformTaskRegistry implements SmartInitializingSingleton {
    record Handler(Object bean, Method method, PlatformTask config, Class<?> parameterType) {}
    private final ApplicationContext context; private final ObjectMapper mapper;
    private final Map<String, Handler> handlers = new ConcurrentHashMap<>();
    public PlatformTaskRegistry(ApplicationContext context, ObjectMapper mapper) { this.context = context; this.mapper = mapper; }
    @Override public void afterSingletonsInstantiated() {
        context.getBeansOfType(Object.class).forEach((name, bean) -> ReflectionUtils.doWithMethods(AopUtils.getTargetClass(bean), method -> {
            PlatformTask task = AnnotatedElementUtils.findMergedAnnotation(method, PlatformTask.class); if (task == null) return;
            Parameter[] parameters = method.getParameters();
            if (parameters.length > 2 || (parameters.length == 2 && parameters[1].getType() != TaskExecutionContext.class)) throw new IllegalStateException("@PlatformTask 参数必须是 DTO[, TaskExecutionContext]: " + task.name());
            Class<?> parameterType = parameters.length == 0 ? Void.class : parameters[0].getType();
            if (handlers.putIfAbsent(task.name(), new Handler(bean, method, task, parameterType)) != null) throw new IllegalStateException("重复的 @PlatformTask 名称: " + task.name());
        }));
    }
    public List<Map<String, Object>> descriptors() { return handlers.entrySet().stream().map(entry -> { Handler h=entry.getValue(); Map<String,Object> value=new LinkedHashMap<>(); value.put("methodName",entry.getKey()); value.put("description",h.config.description()); value.put("riskLevel",h.config.riskLevel()); value.put("timeoutSeconds",h.config.timeoutSeconds()); value.put("allowConcurrent",h.config.allowConcurrent()); value.put("idempotent",h.config.idempotent()); value.put("parameterSchema",schema(h.parameterType)); return value; }).toList(); }
    public Object invoke(String name, Map<String,Object> parameters, TaskExecutionContext executionContext) throws Exception { Handler h=handlers.get(name); if(h==null) throw new IllegalArgumentException("未注册的任务方法: "+name); Object[] args=h.parameterType==Void.class?new Object[0]:h.method.getParameterCount()==2?new Object[]{mapper.convertValue(parameters,h.parameterType),executionContext}:new Object[]{mapper.convertValue(parameters,h.parameterType)}; ReflectionUtils.makeAccessible(h.method); return h.method.invoke(h.bean,args); }
    private Map<String,Object> schema(Class<?> type) { if(type==Void.class)return Map.of("type","object","properties",Map.of()); JavaType javaType=mapper.constructType(type); Map<String,Object> props=new LinkedHashMap<>(); mapper.getSerializationConfig().introspect(javaType).findProperties().forEach(p->props.put(p.getName(),Map.of("type",jsonType(p.getPrimaryType().getRawClass())))); return Map.of("type","object","properties",props); }
    private String jsonType(Class<?> type){if(type==boolean.class||type==Boolean.class)return "boolean";if(Number.class.isAssignableFrom(type)||type.isPrimitive()&&type!=char.class)return "number";if(type.isArray()||Iterable.class.isAssignableFrom(type))return "array";if(type==String.class||type.isEnum())return "string";return "object";}
}
