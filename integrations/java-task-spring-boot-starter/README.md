# Code Studio Java Task Starter

在业务服务中引入本模块，并配置：

```yaml
code-studio:
  tasks:
    platform-url: http://code-generator-api:3000
    application-name: order-service
    registration-token: ${CODE_STUDIO_TASK_TOKEN}
```

只会注册显式标注的方法：

```java
@PlatformTask(name = "order.refreshStatistics", idempotent = true)
public TaskResult refresh(RefreshParams params, TaskExecutionContext context) {
    return TaskResult.success("刷新完成", Map.of("updatedRows", 120));
}
```

令牌必须通过 Secret 注入，不应提交到代码仓库。任务方法需要自行实现事务边界、幂等和业务级权限校验。
