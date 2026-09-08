CREATE TABLE "_DatasourceApprovers" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_DatasourceApprovers_AB_unique" ON "_DatasourceApprovers"("A", "B");
CREATE INDEX "_DatasourceApprovers_B_index" ON "_DatasourceApprovers"("B");

ALTER TABLE "_DatasourceApprovers"
  ADD CONSTRAINT "_DatasourceApprovers_A_fkey" FOREIGN KEY ("A") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_DatasourceApprovers"
  ADD CONSTRAINT "_DatasourceApprovers_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 兼容已有数据源：现有成员默认成为审批人，管理员可在数据源管理页重新配置。
INSERT INTO "_DatasourceApprovers" ("A", "B")
SELECT "datasourceId", "userId" FROM "DatasourceMember"
ON CONFLICT DO NOTHING;
