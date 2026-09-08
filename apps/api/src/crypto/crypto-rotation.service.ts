import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

const ALERT_NOTIFICATION_KEY = 'monitoring.alert_notification';

type ResourceName = 'deployTargets' | 'registries' | 'modelConfigs' | 'gitCredentials' | 'datasources' | 'alertNotifications';
type ResourceStat = { total: number; needingRotation: number; keyIds: Record<string, number> };
type RotationStatus = { activeKeyId: string; total: number; needingRotation: number; resources: Record<ResourceName, ResourceStat> };

@Injectable()
export class CryptoRotationService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  async status(): Promise<RotationStatus> {
    return this.inspect(this.prisma);
  }

  async rotateAll() {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.inspect(tx);
      const deployTargets = await tx.deployTarget.findMany({ select: { id: true, encryptedConfig: true } });
      const registries = await tx.registry.findMany({ select: { id: true, encryptedConfig: true } });
      const modelConfigs = await tx.modelConfig.findMany({ select: { id: true, encryptedKey: true } });
      const gitCredentials = await tx.gitCredential.findMany({ select: { id: true, encryptedToken: true } });
      const datasources = await tx.datasource.findMany({ select: { id: true, encryptedConfig: true } });

      await Promise.all([
        ...deployTargets.filter((row) => this.crypto.needsRotation(row.encryptedConfig)).map((row) => tx.deployTarget.update({ where: { id: row.id }, data: { encryptedConfig: this.crypto.rotate(row.encryptedConfig) } })),
        ...registries.filter((row) => this.crypto.needsRotation(row.encryptedConfig)).map((row) => tx.registry.update({ where: { id: row.id }, data: { encryptedConfig: this.crypto.rotate(row.encryptedConfig) } })),
        ...modelConfigs.filter((row) => this.crypto.needsRotation(row.encryptedKey)).map((row) => tx.modelConfig.update({ where: { id: row.id }, data: { encryptedKey: this.crypto.rotate(row.encryptedKey) } })),
        ...gitCredentials.filter((row) => this.crypto.needsRotation(row.encryptedToken)).map((row) => tx.gitCredential.update({ where: { id: row.id }, data: { encryptedToken: this.crypto.rotate(row.encryptedToken) } })),
        ...datasources.filter((row) => this.crypto.needsRotation(row.encryptedConfig)).map((row) => tx.datasource.update({ where: { id: row.id }, data: { encryptedConfig: this.crypto.rotate(row.encryptedConfig) } })),
      ]);

      const alert = await tx.systemSetting.findUnique({ where: { key: ALERT_NOTIFICATION_KEY } });
      if (alert) {
        const value = alert.value as Record<string, unknown>;
        const encryptedUrl = typeof value.encryptedUrl === 'string' ? this.crypto.rotate(value.encryptedUrl) : value.encryptedUrl;
        const encryptedSecret = typeof value.encryptedSecret === 'string' ? this.crypto.rotate(value.encryptedSecret) : value.encryptedSecret;
        if (encryptedUrl !== value.encryptedUrl || encryptedSecret !== value.encryptedSecret) {
          await tx.systemSetting.update({
            where: { key: ALERT_NOTIFICATION_KEY },
            data: { value: { ...value, encryptedUrl, encryptedSecret } as Prisma.InputJsonValue },
          });
        }
      }
      return { ...await this.inspect(tx), rotated: before.needingRotation };
    });
  }

  private async inspect(db: PrismaService | Prisma.TransactionClient): Promise<RotationStatus> {
    const [deployTargets, registries, modelConfigs, gitCredentials, datasources, alert] = await Promise.all([
      db.deployTarget.findMany({ select: { encryptedConfig: true } }),
      db.registry.findMany({ select: { encryptedConfig: true } }),
      db.modelConfig.findMany({ select: { encryptedKey: true } }),
      db.gitCredential.findMany({ select: { encryptedToken: true } }),
      db.datasource.findMany({ select: { encryptedConfig: true } }),
      db.systemSetting.findUnique({ where: { key: ALERT_NOTIFICATION_KEY }, select: { value: true } }),
    ]);
    const alertValue = alert?.value as Record<string, unknown> | undefined;
    const alertBlobs = [alertValue?.encryptedUrl, alertValue?.encryptedSecret].filter((value): value is string => typeof value === 'string');
    const resources = {
      deployTargets: this.stat(deployTargets.map((row) => row.encryptedConfig)),
      registries: this.stat(registries.map((row) => row.encryptedConfig)),
      modelConfigs: this.stat(modelConfigs.map((row) => row.encryptedKey)),
      gitCredentials: this.stat(gitCredentials.map((row) => row.encryptedToken)),
      datasources: this.stat(datasources.map((row) => row.encryptedConfig)),
      alertNotifications: this.stat(alertBlobs),
    };
    const values = Object.values(resources);
    return {
      activeKeyId: this.crypto.activeId(),
      total: values.reduce((sum, item) => sum + item.total, 0),
      needingRotation: values.reduce((sum, item) => sum + item.needingRotation, 0),
      resources,
    };
  }

  private stat(blobs: string[]): ResourceStat {
    const keyIds: Record<string, number> = {};
    for (const blob of blobs) {
      const id = this.crypto.envelopeKeyId(blob);
      keyIds[id] = (keyIds[id] || 0) + 1;
    }
    return { total: blobs.length, needingRotation: blobs.filter((blob) => this.crypto.needsRotation(blob)).length, keyIds };
  }
}
