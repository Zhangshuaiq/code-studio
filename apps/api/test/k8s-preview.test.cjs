const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePreviewBindingConfig } = require('../dist/preview/k8s-preview.service.js');

test('Kubernetes preview binding accepts a controlled image and domain', () => {
  const config = validatePreviewBindingConfig({
    image: 'harbor.example.com/team/app:preview-123',
    baseDomain: 'preview.example.com',
    env: { NODE_ENV: 'preview' },
    allowInternet: false,
  });
  assert.equal(config.image, 'harbor.example.com/team/app:preview-123');
});

test('Kubernetes preview binding accepts BuildKit repository and HTTPS context', () => {
  const config = validatePreviewBindingConfig({
    imageRepository: 'harbor.example.com/team/app',
    registryId: '01234567-89ab-cdef-0123-456789abcdef',
    buildContext: 'https://git.example.com/team/app.git#main',
    registryAuthSecret: 'harbor-push',
    baseDomain: 'preview.example.com',
    buildEgressCidrs: ['10.20.0.0/16'],
    buildRetries: 2,
    buildTimeoutSeconds: 900,
  });
  assert.equal(config.imageRepository, 'harbor.example.com/team/app');
});

test('Kubernetes preview binding rejects missing image and unsafe env', () => {
  assert.throws(() => validatePreviewBindingConfig({ baseDomain: 'preview.example.com' }), /image/);
  assert.throws(() => validatePreviewBindingConfig({ image: 'repo/app:v1', baseDomain: 'preview.example.com', env: { 'BAD-KEY': 'x' } }), /环境变量非法/);
  assert.throws(() => validatePreviewBindingConfig({ imageRepository: 'repo/app', buildContext: 'file:///tmp/app', baseDomain: 'preview.example.com' }), /buildContext/);
  assert.throws(() => validatePreviewBindingConfig({ image: 'repo/app:v1', baseDomain: 'preview.example.com', buildRetries: 9 }), /buildRetries/);
});
