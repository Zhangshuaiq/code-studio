const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { GUARDS_METADATA } = require('@nestjs/common/constants');
const { PERMISSIONS_KEY } = require('../dist/auth/require-permissions.decorator.js');
const { PermissionsGuard } = require('../dist/auth/permissions.guard.js');

const protectedControllers = [
  require('../dist/deploy/registry.controller.js').RegistryController,
  require('../dist/model-config/model-config.controller.js').ModelConfigController,
  require('../dist/db-query/db-query.controller.js').DbQueryController,
  require('../dist/k8s/k8s.controller.js').K8sController,
  require('../dist/api-metrics/api-metrics.controller.js').ApiMetricsController,
  require('../dist/platform-health/platform-health.controller.js').PlatformHealthController,
];

test('sensitive controllers have both permission metadata and PermissionsGuard', () => {
  for (const controller of protectedControllers) {
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller) || [];
    const permissions = Reflect.getMetadata(PERMISSIONS_KEY, controller) || [];
    assert.ok(guards.includes(PermissionsGuard), `${controller.name} 缺少 PermissionsGuard`);
    assert.ok(permissions.length > 0, `${controller.name} 缺少权限声明`);
  }
});
