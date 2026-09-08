import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/jwt.strategy';
import { ModelConfigService } from './model-config.service';
import { CreateModelConfigDto } from './dto/create-model-config.dto';
import { UpdateModelConfigDto } from './dto/update-model-config.dto';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { Audit } from '../audit/audit.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.MODEL_MANAGE)
@Controller('model-configs')
export class ModelConfigController {
  constructor(private readonly configs: ModelConfigService) {}

  @Post()
  @Audit('model-config.create', 'model-config')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateModelConfigDto) {
    return this.configs.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.configs.findAll(user.id);
  }

  @Patch(':id')
  @Audit('model-config.update', 'model-config')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateModelConfigDto,
  ) {
    return this.configs.update(user.id, id, dto);
  }

  @Delete(':id')
  @Audit('model-config.delete', 'model-config')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.configs.remove(user.id, id);
  }
}
