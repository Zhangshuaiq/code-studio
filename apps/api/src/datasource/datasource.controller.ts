import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PERMISSIONS } from '../auth/permissions';
import { CurrentUser } from '../auth/current-user.decorator';
import { Audit } from '../audit/audit.decorator';
import { DatasourceService } from './datasource.service';
import { CreateDatasourceDto, DatasourceListQueryDto, DatasourceMembersDto, UpdateDatasourceDto } from './dto/datasource.dto';

@Controller('admin/datasources')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DatasourceController {
  constructor(private readonly ds: DatasourceService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  listDatasources(
    @CurrentUser('id') userId: string,
    @Query() query: DatasourceListQueryDto,
  ) {
    return this.ds.listDatasources(userId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  getDatasource(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.ds.getDatasource(id, userId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.create', 'datasource')
  createDatasource(
    @Body() body: CreateDatasourceDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.ds.createDatasource(body, userId);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.update', 'datasource')
  updateDatasource(
    @Param('id') id: string,
    @Body() body: UpdateDatasourceDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.ds.updateDatasource(id, body, userId);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.delete', 'datasource')
  deleteDatasource(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.ds.deleteDatasource(id, userId);
  }

  @Post(':id/members')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.add-members', 'datasource')
  addMembers(
    @Param('id') id: string,
    @Body() body: DatasourceMembersDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.ds.addMembers(userId, id, body.userIds);
  }

  @Delete(':id/members')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.remove-members', 'datasource')
  removeMembers(
    @Param('id') id: string,
    @Body() body: DatasourceMembersDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.ds.removeMembers(userId, id, body.userIds);
  }

  @Patch(':id/approvers')
  @RequirePermissions(PERMISSIONS.DATASOURCE_MANAGE)
  @Audit('datasource.set-approvers', 'datasource')
  setApprovers(@Param('id') id: string, @Body() body: DatasourceMembersDto, @CurrentUser('id') userId: string) {
    return this.ds.setApprovers(userId, id, body.userIds || []);
  }
}
