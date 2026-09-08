import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { Audit } from '../audit/audit.decorator';
import { RegistryService } from './registry.service';
import { CreateRegistryDto } from './dto/registry.dto';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.REGISTRY_MANAGE)
@Controller('registries')
export class RegistryController {
  constructor(private readonly registries: RegistryService) {}

  @Post()
  @Audit('registry.create', 'registry')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateRegistryDto,
  ) {
    return this.registries.create(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.registries.list(user.id);
  }

  @Delete(':id')
  @Audit('registry.delete', 'registry')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.registries.remove(user.id, id);
  }
}
