{{- define "codegen.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end }}
{{- define "codegen.fullname" -}}{{ default (printf "%s-%s" .Release.Name (include "codegen.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- end }}
{{- define "codegen.labels" -}}
app.kubernetes.io/name: {{ include "codegen.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}
{{- define "codegen.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codegen.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "codegen.serviceAccountName" -}}{{ default (include "codegen.fullname" .) .Values.serviceAccount.name }}{{- end }}
{{- define "codegen.secretName" -}}
{{- if .Values.externalSecrets.enabled -}}
{{- default (printf "%s-secrets" (include "codegen.fullname" .)) .Values.externalSecrets.targetSecretName -}}
{{- else -}}
{{- default (printf "%s-secrets" (include "codegen.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}
{{- end }}
{{- define "codegen.workspaceClaim" -}}{{ default (printf "%s-workspace" (include "codegen.fullname" .)) .Values.persistence.existingClaim }}{{- end }}
{{- define "codegen.generationWorkspaceClaim" -}}{{ default (include "codegen.workspaceClaim" .) .Values.runtime.kubernetes.workspaceClaim }}{{- end }}
{{- define "codegen.generationServiceAccountName" -}}{{ default (printf "%s-generation-job" (include "codegen.fullname" .)) .Values.runtime.kubernetes.jobServiceAccountName }}{{- end }}
