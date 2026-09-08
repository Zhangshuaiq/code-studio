const { PrismaClient } = require('@prisma/client');
const { createCipheriv, randomBytes } = require('crypto');
const { readFileSync } = require('fs');
const { resolve } = require('path');

loadEnv(resolve(__dirname, '../.env'));

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({ where: { username: 'demo' } });
  if (!user) throw new Error('缺少 demo 用户，请先准备基础演示数据');
  const project = await prisma.project.findFirst({
    where: { userId: user.id, name: 'demo-gate' },
  });
  if (!project) throw new Error('缺少 demo/demo-gate 项目，请先准备基础演示数据');

  await prisma.role.upsert({
    where: { name: 'developer' },
    create: {
      name: 'developer',
      description: '开发者（代码生成、预览与业务日志）',
      permissions: [
        'project:read',
        'project:write',
        'generate:execute',
        'model:manage',
        'business-log:read',
        'business-log:source-manage',
      ],
      builtin: true,
    },
    update: {
      description: '开发者（代码生成、预览与业务日志）',
      permissions: [
        'project:read',
        'project:write',
        'generate:execute',
        'model:manage',
        'business-log:read',
        'business-log:source-manage',
      ],
    },
  });

  const releaseRole = await prisma.role.upsert({
    where: { name: 'release-manager' },
    create: {
      name: 'release-manager',
      description: '发布负责人（选择项目、分支和环境并执行部署）',
      permissions: ['project:read', 'deploy:execute', 'business-log:read'],
      builtin: true,
    },
    update: {
      description: '发布负责人（选择项目、分支和环境并执行部署）',
      permissions: ['project:read', 'deploy:execute', 'business-log:read'],
      builtin: true,
    },
  });
  const opsRole = await prisma.role.upsert({
    where: { name: 'ops-manager' },
    create: {
      name: 'ops-manager',
      description: '运维负责人（运行资源、镜像仓库与项目环境配置）',
      permissions: [
        'project:read',
        'deploy:execute',
        'deploy-target:manage',
        'registry:manage',
        'business-log:read',
      ],
      builtin: true,
    },
    update: {
      description: '运维负责人（运行资源、镜像仓库与项目环境配置）',
      permissions: [
        'project:read',
        'deploy:execute',
        'deploy-target:manage',
        'registry:manage',
        'business-log:read',
      ],
      builtin: true,
    },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { roles: { connect: [{ id: releaseRole.id }, { id: opsRole.id }] } },
  });

  const encryptedConfig = encrypt(JSON.stringify({ publicHost: 'localhost' }));
  const existing = await prisma.deployTarget.findFirst({
    where: { userId: user.id, name: '【演示】平台本机 Docker' },
  });
  const target = existing
    ? await prisma.deployTarget.update({
        where: { id: existing.id },
        data: {
          kind: 'local-docker',
          encryptedConfig,
          summary: '平台 API 节点 Docker',
          scope: 'platform',
          teamId: null,
          purposes: ['preview', 'deploy'],
          labels: ['env=dev', 'region=local', 'demo'],
          enabled: true,
          maxPreviewInstances: 4,
          capacityCpu: 4,
          capacityMemoryMb: 4096,
        },
      })
    : await prisma.deployTarget.create({
        data: {
          userId: user.id,
          name: '【演示】平台本机 Docker',
          kind: 'local-docker',
          encryptedConfig,
          summary: '平台 API 节点 Docker',
          scope: 'platform',
          purposes: ['preview', 'deploy'],
          labels: ['env=dev', 'region=local', 'demo'],
          enabled: true,
          maxPreviewInstances: 4,
          capacityCpu: 4,
          capacityMemoryMb: 4096,
        },
      });

  await prisma.projectRuntimeBinding.upsert({
    where: {
      projectId_purpose_environment: {
        projectId: project.id,
        purpose: 'preview',
        environment: 'preview',
      },
    },
    create: {
      projectId: project.id,
      targetId: target.id,
      purpose: 'preview',
      environment: 'preview',
      branchPattern: '*',
    },
    update: { targetId: target.id, enabled: true },
  });
  await prisma.projectRuntimeBinding.upsert({
    where: {
      projectId_purpose_environment: {
        projectId: project.id,
        purpose: 'deploy',
        environment: 'test',
      },
    },
    create: {
      projectId: project.id,
      targetId: target.id,
      purpose: 'deploy',
      environment: 'test',
      branchPattern: '*',
    },
    update: { targetId: target.id, enabled: true },
  });

  const sampleCount = await prisma.deploymentRecord.count({
    where: { projectId: project.id, deployedByName: '演示发布人' },
  });
  if (!sampleCount) {
    await prisma.deploymentRecord.createMany({
      data: [
        {
          projectId: project.id,
          targetId: target.id,
          targetName: target.name,
          environment: 'test',
          branch: 'main',
          gitSha: '84a1d9e7demo',
          status: 'stopped',
          deployedById: user.id,
          deployedByName: '演示发布人',
          logsTail: '演示部署完成，随后由发布负责人停止。',
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
        {
          projectId: project.id,
          targetId: target.id,
          targetName: target.name,
          environment: 'test',
          branch: 'feature/demo',
          gitSha: '31bce246demo',
          status: 'failed',
          deployedById: user.id,
          deployedByName: '演示发布人',
          logsTail: '演示失败记录：健康检查未通过。',
          createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
        },
      ],
    });
  }
  await prisma.deployment.upsert({
    where: { projectId: project.id },
    create: {
      projectId: project.id,
      targetId: target.id,
      targetName: target.name,
      environment: 'test',
      branch: 'main',
      deployedById: user.id,
      deployedByName: '演示发布人',
      gitSha: '84a1d9e7demo',
      status: 'stopped',
      logsTail: '演示部署已停止。',
    },
    update: {},
  });

  console.log(`已准备运行资源演示数据：${project.name} -> ${target.name}`);
}

function loadEnv(path) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function encrypt(plain) {
  const keyHex = process.env.CRED_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('CRED_ENCRYPTION_KEY 必须是 64 位 hex');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
