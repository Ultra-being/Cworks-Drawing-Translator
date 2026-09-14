import { useRef, useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { UnresolvedBlockEditor } from "@/components/UnresolvedBlockEditor";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Download, FileArchive, FileText,
  Loader2, LockKeyhole, LogOut, MessageSquare, Ruler, Trash2, Upload, X, Check, Wrench, MapPin,
} from "lucide-react";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const API = "/api/cworks-translator";

type CadStatus = "queued" | "running" | "awaiting_review" | "revising" | "done" | "failed" | "deleting";
type CworksAuthStatus = {
  authenticated: boolean;
  workspaceIdentity: { id: string; name: string; role: string } | null;
  derivativeReviewAuthorized: boolean;
};

type ReviewHistory = {
  id?: number;
  reviewerName: string;
  reviewerQualification: string;
  decision: string;
  declaration: string;
  cadOperatorName?: string | null;
  cadOperatorQualification?: string | null;
  cadOperatorDeclaration?: boolean;
  translatedOutputSha256?: string | null;
  notes: string;
  revisionCount: number;
  createdAt: string;
  derivativeId?: string | null;
  derivativeEvidenceSnapshot?: {
    derivativeId: string;
    derivativeSha256: string;
  } | null;
};

type CadJob = {
  id: string; title: string; sourceLanguage: string; targetLanguage?: 'en' | 'ja'; scope: string;
  sourceFormat?: "pdf" | "dxf";
  drawingDepth: string; status: CadStatus; progress: number; progressNote: string | null;
  pageCount: number | null; pagesDone: number; originalFilename: string | null;
  feedbackNotes: string | null; errorMessage: string | null; tokenEstimate: number | null;
  costEstimate: string | null; revisionCount: number; createdAt: string;
  machineAuditStatus?: "passed" | "findings";
  machineAuditModel?: string;
  approvedRevision?: number | null;
  approvedAt?: string | null;
  derivatives?: CadDerivative[];
};

type RetryMetadata = {
  resumeAvailable: boolean;
  resumeEligibility: "unavailable" | "provisional";
  fullRestartAvailable: boolean;
  checkpointCount: number;
  checkpointRevision: number | null;
  resumeReason: string;
  resumeValidationNote: string;
  fullRestartWarning: string;
};

type DownloadAvailability = {
  original: boolean;
  output: boolean;
  summary: boolean;
  ledger: boolean;
  preservationReport: boolean;
  tableScript: boolean;
  draftDxf: boolean;
};

type CadDerivativeReviewStatus = "pending_review" | "approved" | "revision_requested" | "stale";

type CadDerivativeDraftBinding = {
  format: "cworks-hybrid-derivative-requirements-v1";
  lineageKind: "hybrid_draft_completion";
  sourceRevision: number;
  sourceSha256: string;
  sourceOutputSha256: string;
  preservationReportSha256: string;
  ledgerSha256: string;
  placementManifestSha256: string;
  tableScriptSha256: string;
  tableManifestSha256: string;
  tableTargetCount: number;
  expectedCounters: CadApplicationCounters;
  manualRequirementIds: string[];
  machineDefectCount: number;
  independentAuditModel: string;
  applicationOutputCaptureSupported: boolean;
  submissionAllowed: boolean;
  requiredAttestation: string;
};

type CadApplicationCounters = {
  expected: number;
  applied: number;
  missing: number;
  ambiguous: number;
  failed: number;
  skipped: number;
};

type CadApplicationOutputValidation =
  | { valid: true }
  | { valid: false; message: string };

function validateCadApplicationOutput(
  output: string,
  binding: Pick<CadDerivativeDraftBinding, "tableManifestSha256" | "tableTargetCount" | "expectedCounters">,
): CadApplicationOutputValidation {
  if (!output.trim()) {
    return { valid: false, message: "Paste or attach the complete AutoCAD command output." };
  }
  if (/Cworks (?:aborted|cancelled)\b/i.test(output)) {
    return { valid: false, message: "This output reports an aborted or cancelled run. Run the command again and capture a complete successful result." };
  }
  const begins = [...output.matchAll(/CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN manifestSha256=([0-9a-f]{64})/g)];
  const summaries = [...output.matchAll(/Cworks table translations: matchedTargets=(\d+) appliedCells=(\d+) skippedTargets=(\d+) countMismatch=(\d+) unsafeCells=(\d+) partialErrors=(\d+) errors=(\d+)/g)];
  const ends = [...output.matchAll(/CWORKS_APPLY_TABLE_TRANSLATIONS_END manifestSha256=([0-9a-f]{64})/g)];
  if (begins.length !== 1 || summaries.length !== 1 || ends.length !== 1) {
    return { valid: false, message: "Output must contain exactly one complete BEGIN marker, seven-counter summary, and END marker." };
  }
  const begin = begins[0];
  const summary = summaries[0];
  const end = ends[0];
  const beginEnd = begin.index! + begin[0].length;
  const summaryEnd = summary.index! + summary[0].length;
  if (
    begin.index! >= summary.index!
    || summary.index! >= end.index!
    || output.slice(beginEnd, summary.index).trim()
    || output.slice(summaryEnd, end.index).trim()
  ) {
    return { valid: false, message: "The BEGIN marker, seven-counter summary, and END marker must form one uninterrupted block in that order." };
  }
  if (begin[1] !== binding.tableManifestSha256 || end[1] !== binding.tableManifestSha256) {
    return { valid: false, message: "This output belongs to a different table manifest. Run the script from the current draft package." };
  }
  const counters = {
    matchedTargets: Number(summary[1]),
    appliedCells: Number(summary[2]),
    skippedTargets: Number(summary[3]),
    countMismatch: Number(summary[4]),
    unsafeCells: Number(summary[5]),
    partialErrors: Number(summary[6]),
    errors: Number(summary[7]),
  };
  if (counters.matchedTargets !== binding.tableTargetCount || counters.appliedCells !== binding.expectedCounters.applied) {
    return {
      valid: false,
      message: `Output counts do not match this draft: expected matchedTargets=${binding.tableTargetCount} and appliedCells=${binding.expectedCounters.applied}.`,
    };
  }
  const failedCounters = ([
    "skippedTargets", "countMismatch", "unsafeCells", "partialErrors", "errors",
  ] as const).filter(key => counters[key] !== 0);
  if (failedCounters.length) {
    return {
      valid: false,
      message: `The run was not fully successful: ${failedCounters.map(key => `${key}=${counters[key]}`).join(", ")}. All five failure counters must be zero.`,
    };
  }
  return { valid: true };
}

type CadDerivative = {
  id: string;
  originalFilename: string;
  format: "dxf" | "dwg";
  operatorName: string;
  operatorQualification: string;
  operatorNotes: string;
  operatorAttestation: string;
  sourceRevision: number;
  sha256: string;
  source: {
    revision: number;
    translatedOutputSha256: string;
    approvalEventId: number | null;
  };
  lineageKind?: "hybrid_draft_completion" | "approved_source_touchup";
  evidence?: {
    format?: string;
    derivativeSha256?: string;
    sourceRevision?: number;
    sourceSha256?: string;
    translatedOutputSha256?: string;
    preservationReportSha256?: string;
    ledgerSha256?: string;
    placementManifestSha256?: string;
    tableScriptSha256?: string;
    tableManifestSha256?: string;
    tableTargetCount?: number;
    expectedAppliedCount?: number;
    machineDefectCount?: number;
    independentAuditModel?: string;
    counters?: CadApplicationCounters;
    applicationOutput?: {
      text: string;
      sha256: string;
      parsedCounters: {
        matchedTargets: number;
        appliedCells: number;
        skippedTargets: number;
        countMismatch: number;
        unsafeCells: number;
        partialErrors: number;
        errors: number;
      };
    };
    manualCoverageResolutions?: Array<{
      requirementId: string;
      resolution: string;
    }>;
    operationalVerification?: {
      platform: "windows_autocad";
      autoCadMajorVersion: number;
      lispSys: 1 | 2;
      sourceScriptManifestHashesVerified: true;
      partialApplicationEvidenceDisposition: "discarded";
      savedClosedReopened: true;
      reopenedInspectionNotes: string;
    };
  } | null;
  stale?: boolean;
  manualCoverageResolutions?: Array<{
    itemId: string;
    resolution: string;
  }>;
  artifactClass: "human_edited_cad_derivative";
  preservationProof: false;
  bytePreservationClaim: false;
  downloadUrl: string;
  draftDownloadUrl?: string | null;
  lineageReportUrl: string;
  createdAt: string;
};
type CadPage = {
  id: number;
  pageNumber: number;
  thumbnailUrl: string | null;
  sourceThumbnailUrl?: string | null;
  sourceBlockCount: number;
  translatedBlockCount: number;
  warnings: string[];
  unresolvedLines?: UnresolvedLine[];
  previewMetadata?: PreviewMetadata | null;
  machineAuditStatus?: "passed" | "findings";
  machineAuditFindings?: Array<{type: string, message: string, sourceBlockId?: string}>;
  review?: null | {
    checked: boolean;
    resolvedFindingIndexes: number[];
    notes: string | null;
    checkedAt: string | null;
  };
};

type PreviewMetadata = {
  pixelWidth: number;
  pixelHeight: number;
  pageWidthPoints: number;
  pageHeightPoints: number;
};

type UnresolvedLine = {
  blockId: string;
  sourceText: string;
  currentTranslation: string;
  pageNumber: number;
  bbox: [number, number, number, number];
  rejectionCategory: string;
};

const rejectionLabels: Record<string, string> = {
  uncertain_translation: "Translation uncertainty",
  missing_translation: "Missing translation",
  unsupported_direction: "Unsupported text direction",
  overlap: "Overlap with nearby drawing content",
  text_too_long: "Replacement text is too long",
};

type CadCoverage = {
  hybridPending?: boolean;
  targetLineCount: number;
  recoveredLineCount: number;
  translatedLineCount: number;
  placedLineCount: number;
  unresolvedLineCount: number;
  placementPercent: number;
  severelyIncomplete: boolean;
  complete: boolean;
};

type CadHealth = { ok: boolean; translatorReady: boolean; translatorProvider: "gemini" | "claude" | null };

const CAD_DERIVATIVE_ATTESTATION =
  "I attest that I am the identified qualified CAD operator, that I created and checked this human-edited CAD derivative from the linked approved native DXF revision, and that this derivative is not preservation proof and makes no byte-preservation claim.";
const languageLabels: Record<string, string> = { auto: "Auto-detect", ru: "Russian", ja: "Japanese", zh: "Chinese", ko: "Korean", de: "German", fr: "French", es: "Spanish", ar: "Arabic", he: "Hebrew", other: "Other" };
const statusMeta: Record<CadStatus, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "bg-slate-100 text-slate-700 border-slate-200" },
  running: { label: "Translating", tone: "bg-sky-50 text-sky-700 border-sky-200" },
  awaiting_review: { label: "Review needed", tone: "bg-amber-50 text-amber-700 border-amber-200" },
  revising: { label: "Revision in progress", tone: "bg-violet-50 text-violet-700 border-violet-200" },
  done: { label: "Approved", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  failed: { label: "Failed", tone: "bg-red-50 text-red-700 border-red-200" },
  deleting: { label: "Deleting", tone: "bg-slate-100 text-slate-600 border-slate-200" },
};

function StatusBadge({ status }: { status: CadStatus }) {
  const meta = statusMeta[status] || statusMeta.queued;
  return <Badge variant="outline" className={`text-[11px] font-medium shadow-none ${meta.tone}`}>{meta.label}</Badge>;
}

function apiError(body: any, fallback: string) { return body?.error || fallback; }

export default function TranslatorPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: auth, isLoading: authLoading } = useQuery<CworksAuthStatus>({
    queryKey: ["auth-status"],
    queryFn: async () => (await fetch(`${API}/auth/status`)).json(),
  });

  const { data: health } = useQuery<CadHealth>({
    queryKey: ["health"],
    enabled: auth?.authenticated === true,
    queryFn: async () => (await fetch(`${API}/health`)).json(),
  });

  const logout = useMutation({
    mutationFn: async () => { await fetch(`${API}/auth/logout`, { method: "POST" }); },
    onSuccess: () => { qc.clear(); qc.invalidateQueries(); },
  });

  if (authLoading) return <div className="flex min-h-screen items-center justify-center bg-[hsl(213_32%_97%)]"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!auth?.authenticated) return <PasswordGate onUnlocked={() => qc.invalidateQueries({ queryKey: ["auth-status"] })} />;

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-6 font-sans">
      <div className="mx-auto max-w-[1380px] space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4 bg-white p-5 rounded-xl border shadow-sm">
          <div className="flex items-start gap-4">
            <div className="mt-1 rounded-lg bg-[hsl(194_72%_35%)] p-3 text-white shadow-sm">
              <Ruler className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                 <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[hsl(194_72%_35%)]">The Lookout / Drawing workshop</p>
                 <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">Secure workspace</span>
              </div>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Cworks Drawing Translator</h1>
              <p className="mt-1 max-w-2xl text-sm text-slate-600 font-medium">Translate the text layer of construction and engineering drawing sets without disturbing the linework.</p>
            </div>
          </div>
          <div className="flex gap-2">
            {!selectedId && <Button onClick={() => setCreating(true)} disabled={!health?.translatorReady} className="bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] shadow-sm font-semibold" data-testid="button-new-job"><Upload className="mr-2 h-4 w-4" />Translate drawing set</Button>}
            <Button variant="outline" size="icon" onClick={() => logout.mutate()} aria-label="Sign out" data-testid="button-logout" className="shadow-sm bg-white"><LogOut className="h-4 w-4 text-slate-600" /></Button>
          </div>
        </header>
        {health && !health.translatorReady && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>Translation is temporarily unavailable because no translation provider is configured. Restore the AI integration to continue.</AlertDescription></Alert>}
        {creating && <NewJobForm onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelectedId(id); }} />}
        {!creating && selectedId ? <JobDetail id={selectedId} onBack={() => setSelectedId(null)} /> : !creating && <JobList onOpen={setSelectedId} />}
      </div>
    </main>
  );
}

function PasswordGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(b, "Could not sign in"));
      onUnlocked();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 font-sans">
      <Card className="w-full max-w-sm border-slate-200 bg-white shadow-md">
        <CardContent className="p-8">
          <div className="mx-auto mb-5 w-fit rounded-xl bg-[hsl(194_72%_35%)] p-3.5 text-white shadow-sm"><Ruler className="h-7 w-7" /></div>
          <p className="text-center text-[10px] font-bold uppercase tracking-[0.25em] text-[hsl(194_72%_35%)]">The Lookout</p>
          <h1 className="mt-1.5 text-center text-xl font-bold tracking-tight text-slate-900">Drawing Translator</h1>
          <p className="mt-2 text-center text-xs font-medium text-slate-500 leading-relaxed">Enter the workspace password to open the secure drafting environment.</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Workspace password" autoFocus className="text-center tracking-widest shadow-sm" data-testid="input-password" />
            {error && <p className="text-xs text-red-600 font-semibold text-center" data-testid="text-login-error">{error}</p>}
            <Button type="submit" disabled={!password || busy} className="w-full bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] shadow-sm font-semibold" data-testid="button-login">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}Unlock Workspace
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function JobList({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient(); const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useQuery<{ jobs: CadJob[] }>({
    queryKey: ["jobs"],
    queryFn: async () => { const r = await fetch(`${API}/jobs`); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(apiError(b, "Could not load drawing jobs")); return b; },
  });
  const del = useMutation({ mutationFn: async (id: string) => { const r = await fetch(`${API}/jobs/${id}`, { method: "DELETE" }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(apiError(b, "Could not delete job")); }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["jobs"] }); toast({ title: "Drawing job deleted", description: "Its saved translations and private files are being removed." }); }, onError: (e: Error) => toast({ title: "Could not delete job", description: e.message, variant: "destructive" }) });

  if (isLoading) return <div className="grid gap-3">{[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse rounded-xl bg-white border border-slate-200" />)}</div>;
  if (isError) return <Card><CardContent className="py-10 text-center"><AlertTriangle className="mx-auto h-7 w-7 text-amber-600" /><p className="mt-2 text-sm font-medium">Drawing jobs could not be loaded</p><Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Try again</Button></CardContent></Card>;

  const jobs = data?.jobs || [];
  if (!jobs.length) return <Card className="border-dashed border-2 bg-slate-50/50"><CardContent className="py-20 text-center"><div className="mx-auto w-fit rounded-2xl bg-[hsl(194_72%_35%_/_0.1)] p-4"><FileArchive className="h-8 w-8 text-[hsl(194_72%_35%)]" /></div><h2 className="mt-5 text-lg font-bold text-slate-800">No drawing sets yet</h2><p className="mx-auto mt-2 max-w-sm text-sm font-medium text-slate-500">Start with a PDF or DXF set. The original file is preserved and every job gets a formal review pass.</p></CardContent></Card>;

  return (
    <div className="grid gap-3">
      {jobs.map(job => (
        <Card key={job.id} className="group cursor-pointer border-slate-200 bg-white transition-all hover:border-[hsl(194_72%_35%_/_0.4)] hover:shadow-md" onClick={() => onOpen(job.id)} data-testid={`card-job-${job.id}`}>
          <CardContent className="flex flex-wrap items-center gap-5 px-5 py-4">
            <div className="rounded-lg bg-slate-50 border p-3 text-[hsl(194_72%_35%)]"><FileText className="h-6 w-6" /></div>
            <div className="min-w-[220px] flex-1">
              <div className="flex items-center gap-3">
                <p className="truncate text-base font-bold text-slate-800 tracking-tight">{job.title}</p>
                <Badge variant="outline" className="text-[10px] font-bold shadow-none uppercase tracking-widest text-slate-500 border-slate-300">{job.sourceFormat === 'dxf' ? 'DXF' : 'PDF'}</Badge>
                <StatusBadge status={job.status} />
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs font-medium text-slate-500">
                <span className="max-w-[200px] truncate">{job.originalFilename || (job.sourceFormat === 'dxf' ? "DXF drawing" : "PDF drawing set")}</span>
                <span className="text-slate-300">•</span>
                <span>{job.pageCount || "—"} {job.sourceFormat === 'dxf' ? 'drawing(s)' : 'pages'}</span>
                <span className="text-slate-300">•</span>
                <span>{languageLabels[job.sourceLanguage] || job.sourceLanguage} → {job.targetLanguage === 'ja' ? 'Japanese' : 'English'}</span>
              </div>
            </div>
            <div className="w-full max-w-[240px] md:w-56">
              <div className="mb-1.5 flex justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <span>{job.progressNote || "Progress"}</span>
                <span className="text-slate-600">{job.progress || 0}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100 border shadow-inner">
                <div className="h-full rounded-full bg-[hsl(194_72%_35%)] transition-all duration-500" style={{ width: `${job.progress || 0}%` }} />
              </div>
            </div>
            <Button variant="ghost" size="icon" className="opacity-40 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity" disabled={del.isPending} aria-label={`Delete ${job.title}`} data-testid={`button-delete-job-${job.id}`} onClick={(e) => { e.stopPropagation(); const active = ["queued", "running", "revising"].includes(job.status); const warning = active ? " Active processing will stop after its current operation." : ""; if (window.confirm(`Permanently delete "${job.title}" and all of its saved translations and private files?${warning}`)) del.mutate(job.id); }}>
              {del.isPending && del.variables === job.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-5 w-5" />}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function NewJobForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null); const { toast } = useToast(); const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState(""); const [lang, setLang] = useState("auto"); const [targetLang, setTargetLang] = useState("en"); const [depth, setDepth] = useState("major-text"); const [drag, setDrag] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const pick = (f?: File) => { if (!f) return; if (!/\.(pdf|dxf)$/i.test(f.name)) return setError("Choose a PDF or DXF drawing set."); if (f.size > 100 * 1024 * 1024) return setError("Files must be 100 MB or smaller."); setError(""); setFile(f); if (!title) setTitle(f.name.replace(/\.(pdf|dxf)$/i, "")); };
  const submit = async () => {
    if (!file || !title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const authorization = await fetch(`${API}/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size }),
      });
      const authorizationBody = await authorization.json().catch(() => ({}));
      if (!authorization.ok) {
        throw new Error(apiError(authorizationBody, "Could not prepare the secure upload"));
      }
      const upload = await fetch(authorizationBody.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!upload.ok) {
        throw new Error(`Secure file upload failed (${upload.status}). Please try again.`);
      }
      const creation = await fetch(`${API}/jobs/from-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadToken: authorizationBody.uploadToken,
          title: title.trim(),
          sourceLanguage: lang,
          targetLanguage: targetLang,
          scope: "full",
          drawingDepth: depth,
        }),
      });
      const creationBody = await creation.json().catch(() => ({}));
      if (!creation.ok) throw new Error(apiError(creationBody, "Could not create the translation job"));
      toast({ title: "Drawing set queued", description: "The secure upload was verified and the translation pass is being prepared." });
      onCreated(creationBody.job.id);
    } catch (e: any) {
      setError(e.message || "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-[hsl(194_72%_35%_/_0.25)] bg-white shadow-lg animate-in fade-in duration-200">
      <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/50 pb-4">
        <div>
          <CardTitle className="text-lg font-bold text-slate-800">Prepare a Translation Pass</CardTitle>
          <p className="mt-1.5 text-xs font-medium text-slate-500">PDF or DXF only · maximum 100 MB · original remains securely available</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onCancel} className="text-slate-400 hover:text-slate-700"><X className="h-5 w-5" /></Button>
      </CardHeader>
      <CardContent className="space-y-6 p-6">
        <div onClick={() => input.current?.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }} className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-all ${drag ? "border-[hsl(194_72%_35%)] bg-cyan-50/50" : "border-slate-300 bg-slate-50 hover:border-[hsl(194_72%_35%_/_0.5)] hover:bg-slate-50/50"}`} data-testid="dropzone-pdf">
          <input ref={input} type="file" accept=".pdf,application/pdf,.dxf,application/dxf,image/vnd.dxf" className="hidden" onChange={e => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          {file ? (
            <>
              <FileText className="mx-auto h-10 w-10 text-[hsl(194_72%_35%)]" />
              <p className="mt-3 text-base font-bold text-slate-800">{file.name}</p>
              <p className="text-xs font-medium text-slate-500 mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB · ready to secure upload</p>
            </>
          ) : (
            <>
              <Upload className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-sm font-bold text-slate-700">Drop a PDF or DXF drawing set here</p>
              <p className="text-xs font-medium text-slate-500 mt-1">or browse from your computer</p>
            </>
          )}
        </div>

        <div className="grid gap-5 md:grid-cols-4 bg-slate-50 p-5 rounded-lg border">
          <div className="space-y-2 md:col-span-1">
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Set title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Level 03 fit-out set" data-testid="input-title" className="bg-white shadow-sm" />
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Source language</Label>
            <Select value={lang} onValueChange={setLang}>
              <SelectTrigger className="bg-white shadow-sm"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(languageLabels).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Target language</Label>
            <Select value={targetLang} onValueChange={setTargetLang} required>
              <SelectTrigger className="bg-white shadow-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs font-bold uppercase tracking-wider text-slate-500">Translation depth</Label>
            <Select value={depth} onValueChange={setDepth}>
              <SelectTrigger className="bg-white shadow-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="major-text">Major text only</SelectItem>
                <SelectItem value="everything">Everything visible</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-red-600 bg-red-50 p-3 rounded-md border border-red-100" data-testid="text-upload-error">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onCancel} className="font-semibold">Cancel</Button>
          <Button onClick={submit} disabled={!file || !title.trim() || busy} className="bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] shadow-sm font-semibold" data-testid="button-start-translation">
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading set</> : <><Upload className="mr-2 h-4 w-4" />Start Translation Pass</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PageGrid({ job, pages, onSelect }: { job: CadJob, pages: CadPage[], onSelect: (id: number) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {pages.map(page => {
        const checked = page.review?.checked;
        const findings = page.machineAuditFindings || [];
        const findingsCount = findings.length;
        const resolvedCount = page.review?.resolvedFindingIndexes?.length || 0;
        const pendingFindings = findingsCount - resolvedCount;

        return (
          <button
            key={page.id}
            onClick={() => onSelect(page.id)}
            className={cn(
              "flex flex-col overflow-hidden rounded-xl border text-left transition-all hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[hsl(194_72%_35%)]",
              checked ? "border-emerald-200 bg-emerald-50/20" : "border-slate-200 bg-white hover:border-[hsl(194_72%_35%_/_0.5)]"
            )}
          >
            <div className="flex flex-1 items-stretch min-h-[160px] bg-slate-50/50 border-b relative">
              <div className="w-1/2 p-2.5 border-r flex flex-col items-center justify-center">
                {page.sourceThumbnailUrl ? (
                  <img src={page.sourceThumbnailUrl} alt="Source" className="max-h-[140px] w-auto object-contain shadow-sm border border-slate-200 bg-white rounded-sm" />
                ) : (
                  <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">No Preview</div>
                )}
              </div>
              <div className="w-1/2 p-2.5 flex flex-col items-center justify-center relative bg-white">
                {page.thumbnailUrl ? (
                  <img src={page.thumbnailUrl} alt="Translated" className="max-h-[140px] w-auto object-contain shadow-sm border border-[hsl(194_72%_35%_/_0.2)] bg-white rounded-sm" />
                ) : (
                  <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">No Preview</div>
                )}
                {checked && (
                  <div className="absolute top-2 right-2 bg-emerald-100 border border-emerald-200 text-emerald-700 p-1 rounded-full shadow-sm">
                    <CheckCircle2 className="w-4 h-4" />
                  </div>
                )}
              </div>
            </div>
            <div className="p-4 w-full">
              <div className="flex justify-between items-center mb-1.5">
                <span className="font-bold text-sm text-slate-900 tracking-tight">{job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'} {page.pageNumber}</span>
                {!checked && pendingFindings > 0 && (
                  <Badge variant="secondary" className="bg-amber-100/80 text-amber-800 text-[10px] py-0 border-amber-200 font-bold">
                    {pendingFindings} finding{pendingFindings > 1 ? 's' : ''}
                  </Badge>
                )}
                {!checked && pendingFindings === 0 && findingsCount > 0 && (
                  <Badge variant="secondary" className="bg-emerald-100/80 text-emerald-800 text-[10px] py-0 border-emerald-200 font-bold">
                    Findings resolved
                  </Badge>
                )}
              </div>
              <p className="text-xs font-medium text-slate-500">
                {page.translatedBlockCount} of {page.sourceBlockCount} blocks translated
              </p>
              {page.machineAuditStatus === 'findings' && !checked && pendingFindings > 0 && (
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mt-2 flex items-center bg-amber-50 p-1 rounded-sm border border-amber-100">
                  <AlertTriangle className="w-3 h-3 mr-1" /> AI identified issues
                </p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PageInspector({ job, page, onBack, onPrev, onNext }: { job: CadJob, page: CadPage, onBack: () => void, onPrev?: () => void, onNext?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [notes, setNotes] = useState(page.review?.notes || "");
  const [resolved, setResolved] = useState<number[]>(page.review?.resolvedFindingIndexes || []);
  const [highlightedLine, setHighlightedLine] = useState<UnresolvedLine | null>(null);
  const [touchupBusy, setTouchupBusy] = useState(false);

  useEffect(() => {
    setNotes(page.review?.notes || "");
    setResolved(page.review?.resolvedFindingIndexes || []);
    setHighlightedLine(null);
  }, [page.id, page.review]);

  const findings = page.machineAuditFindings || [];
  const allResolved = findings.length === 0 || findings.length === resolved.length;
  const readOnly = job.status !== "awaiting_review";
  const unresolvedLines = page.unresolvedLines || [];
  const preview = page.previewMetadata;
  const highlightStyle = highlightedLine && preview ? {
    left: `${Math.max(0, highlightedLine.bbox[0] / preview.pageWidthPoints) * 100}%`,
    top: `${Math.max(0, highlightedLine.bbox[1] / preview.pageHeightPoints) * 100}%`,
    width: `${Math.max(0, (highlightedLine.bbox[2] - highlightedLine.bbox[0]) / preview.pageWidthPoints) * 100}%`,
    height: `${Math.max(0, (highlightedLine.bbox[3] - highlightedLine.bbox[1]) / preview.pageHeightPoints) * 100}%`,
  } : undefined;
  const missingPreviewMetadata = highlightedLine && !preview;

  const save = useMutation({
    mutationFn: async (checked: boolean) => {
      const res = await fetch(`${API}/jobs/${job.id}/pages/${page.pageNumber}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked, resolvedFindingIndexes: resolved, notes })
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiError(b, "Failed to save page review"));
      return b;
    },
    onSuccess: (data, variables) => {
      qc.invalidateQueries({ queryKey: ["job", job.id] });
      if (variables === true) {
         toast({ title: `Page ${page.pageNumber} verified` });
         if (onNext) onNext();
      } else {
         toast({ title: "Draft saved" });
      }
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" })
  });

  const previewTouchup = async (line: UnresolvedLine, translation: string, reason: string) => {
    setTouchupBusy(true);
    try {
      const res = await fetch(`${API}/jobs/${job.id}/pages/${page.pageNumber}/touchups/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisionCount: job.revisionCount,
          blockId: line.blockId,
          translation,
          reason,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { success: false, message: apiError(body, "The renderer rejected this touch-up.") };
      return {
        success: true,
        message: body.preview.message,
        previewId: body.preview.id,
        thumbnailUrl: body.preview.thumbnailUrl,
      };
    } finally {
      setTouchupBusy(false);
    }
  };

  const discardTouchup = async (previewId?: string) => {
    if (!previewId) return;
    const res = await fetch(`${API}/jobs/${job.id}/touchups/${previewId}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiError(body, "Could not discard the touch-up preview"));
  };

  const commitTouchup = async (previewId: string) => {
    setTouchupBusy(true);
    try {
      const res = await fetch(`${API}/jobs/${job.id}/touchups/${previewId}/commit`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiError(body, "Could not commit the manual touch-up"));
      toast({
        title: "Manual touch-up revision queued",
        description: "The affected page will be rerendered and the independent audit will run again.",
      });
      await qc.invalidateQueries({ queryKey: ["job", job.id] });
    } catch (error: any) {
      toast({ title: "Touch-up not committed", description: error.message, variant: "destructive" });
    } finally {
      setTouchupBusy(false);
    }
  };

  return (
    <Card className="border-[hsl(194_72%_35%_/_0.2)] shadow-md bg-white overflow-hidden mt-4 animate-in slide-in-from-bottom-2 duration-300">
      <div className="bg-[hsl(194_72%_35%_/_0.03)] border-b px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-semibold -ml-2">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to Overview
          </Button>
          <div className="h-5 w-px bg-slate-300 hidden sm:block"></div>
          <div>
            <h3 className="font-bold text-slate-900 tracking-tight text-lg">{job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'} {page.pageNumber}</h3>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{page.translatedBlockCount} / {page.sourceBlockCount} blocks translated</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPrev} disabled={!onPrev} className="font-semibold shadow-sm">Prev {job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'}</Button>
          <Button variant="outline" size="sm" onClick={onNext} disabled={!onNext} className="font-semibold shadow-sm">Next {job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'}</Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x border-b border-slate-200">
        <div className="p-5 bg-slate-50/80 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <Badge variant="outline" className="bg-slate-200 text-slate-700 shadow-none border-slate-300 font-bold uppercase tracking-wider text-[10px]">Original Document</Badge>
          </div>
          <div className="border border-slate-300 rounded-md bg-white p-2 flex-1 flex items-center justify-center min-h-[500px] shadow-inner overflow-auto">
            {page.sourceThumbnailUrl ? (
              <div className="relative w-fit max-w-full" data-testid="source-preview-region">
                <img src={page.sourceThumbnailUrl} alt="Source" className="block h-auto w-full max-w-none" width={preview?.pixelWidth} height={preview?.pixelHeight} data-testid="source-preview-image" />
                {highlightStyle && <div className="pointer-events-none absolute min-h-[3px] min-w-[3px] border-2 border-red-600 bg-red-400/30 shadow-[0_0_0_2px_rgba(255,255,255,0.9)]" style={highlightStyle} aria-label="Highlighted unresolved drawing region" data-testid="unresolved-region-highlight" />}
              </div>
            ) : (
              <p className="text-sm text-slate-400 font-medium">No preview available</p>
            )}
          </div>
          {missingPreviewMetadata && (
            <Alert variant="destructive" className="mt-3" data-testid="preview-metadata-error">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>The preview scale metadata is missing. The unresolved region cannot be highlighted safely; regenerate this draft before review.</AlertDescription>
            </Alert>
          )}
        </div>
        <div className="p-5 bg-blue-50/20 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <Badge variant="outline" className="bg-[hsl(194_72%_35%_/_0.1)] text-[hsl(194_72%_35%)] shadow-none border-[hsl(194_72%_35%_/_0.3)] font-bold uppercase tracking-wider text-[10px]">{job.targetLanguage === 'ja' ? 'Japanese' : 'English'} Output</Badge>
          </div>
          <div className="border border-[hsl(194_72%_35%_/_0.3)] rounded-md bg-white p-2 flex-1 flex items-center justify-center min-h-[500px] shadow-inner">
            {page.thumbnailUrl ? (
              <img src={page.thumbnailUrl} alt="Translated" className="w-full h-full object-contain" />
            ) : (
              <p className="text-sm text-slate-400 font-medium">No preview available</p>
            )}
          </div>
        </div>
      </div>

      <div className="p-6 grid xl:grid-cols-3 gap-8">
        <div className="xl:col-span-2 space-y-4 flex flex-col">
          <div className="flex items-center justify-between pb-2 border-b">
            <h4 className="font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <AlertTriangle className={cn("h-4 w-4", findings.length > 0 ? "text-amber-600" : "text-slate-400")} />
              Automated Audit Findings
            </h4>
            {findings.length > 0 && (
              <Badge variant="secondary" className="font-bold bg-slate-100 text-slate-700">{resolved.length} / {findings.length} resolved</Badge>
            )}
          </div>

          {findings.length > 0 ? (
            <details className="rounded-lg border border-slate-200 bg-slate-50/60">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-bold text-slate-700 flex items-center justify-between">
                <span>Inspect {findings.length} detailed finding{findings.length === 1 ? "" : "s"}</span>
                <span className="text-xs font-semibold text-slate-500">Unchecked findings will be repaired</span>
              </summary>
              <div className="space-y-3 max-h-[340px] overflow-y-auto px-3 pb-3">
              {findings.map((finding, idx) => {
                const isResolved = resolved.includes(idx);
                return (
                  <label key={idx} htmlFor={`finding-${idx}`} className={cn("flex items-start gap-3.5 p-3.5 rounded-lg border cursor-pointer transition-all", isResolved ? "bg-slate-50 border-slate-200 opacity-70" : "bg-amber-50/50 border-amber-200 hover:bg-amber-50 shadow-sm")}>
                    <Checkbox
                      id={`finding-${idx}`}
                      checked={isResolved}
                       disabled={readOnly}
                      onCheckedChange={(c) => {
                        if (c) setResolved(prev => [...prev, idx]);
                        else setResolved(prev => prev.filter(i => i !== idx));
                      }}
                      className="mt-0.5 shadow-none"
                    />
                    <div className="grid gap-1">
                      <span className={cn("text-sm font-bold", isResolved ? "text-slate-600 line-through" : "text-amber-900")}>{finding.type}</span>
                      <span className={cn("text-sm leading-relaxed", isResolved ? "text-slate-500" : "text-slate-700 font-medium")}>{finding.message}</span>
                    </div>
                  </label>
                );
              })}
              </div>
            </details>
          ) : (
            <div className="p-8 rounded-lg border-2 border-dashed border-slate-200 text-center text-slate-500 bg-slate-50 flex-1 flex flex-col items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-3 opacity-60" />
              <p className="font-bold text-slate-700">Clean pass</p>
              <p className="text-sm font-medium mt-1">No potential issues identified by the machine audit.</p>
            </div>
          )}

          <div className="flex items-center justify-between pb-2 border-b pt-2">
            <h4 className="font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <MapPin className={cn("h-4 w-4", unresolvedLines.length ? "text-red-600" : "text-slate-400")} />
              Unresolved placements
            </h4>
            {unresolvedLines.length > 0 && <Badge variant="secondary" className="font-bold bg-red-50 text-red-700">{unresolvedLines.length}</Badge>}
          </div>
          {unresolvedLines.length ? (
            <div className="space-y-2">
              {unresolvedLines.map((line) => (
                <details
                  key={line.blockId}
                  className="rounded-lg border border-red-200 bg-red-50/40"
                  onToggle={(event) => setHighlightedLine(event.currentTarget.open ? line : null)}
                >
                  <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-red-900">
                    {rejectionLabels[line.rejectionCategory] || line.rejectionCategory}
                  </summary>
                  <div className="grid gap-2 border-t border-red-100 px-4 py-3 text-sm">
                    <p><span className="font-bold text-slate-600">Source text:</span> <span className="break-words text-slate-900">{line.sourceText || "No readable source text"}</span></p>
                    <p><span className="font-bold text-slate-600">{job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'}:</span> {line.pageNumber}</p>
                    <p><span className="font-bold text-slate-600">Block location:</span> x {line.bbox[0].toFixed(1)}–{line.bbox[2].toFixed(1)}, y {line.bbox[1].toFixed(1)}–{line.bbox[3].toFixed(1)}</p>
                    <p><span className="font-bold text-slate-600">Rejection category:</span> {rejectionLabels[line.rejectionCategory] || line.rejectionCategory}</p>
                    {!readOnly && job.sourceFormat !== 'dxf' && (
                      <UnresolvedBlockEditor
                        sourceText={line.sourceText}
                        currentTranslation={line.currentTranslation}
                        rejectionReason={rejectionLabels[line.rejectionCategory] || line.rejectionCategory}
                        targetLanguage={job.targetLanguage}
                        isBusy={touchupBusy}
                        isReadOnly={readOnly}
                        onPreview={(translation, reason) => previewTouchup(line, translation, reason)}
                        onDiscard={discardTouchup}
                        onCommit={commitTouchup}
                        className="mt-2"
                      />
                    )}
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-sm font-medium text-slate-500">Every translated line was placed on this page.</p>
          )}
        </div>

        <div className="space-y-4 flex flex-col">
          <div className="flex-1">
            <Label className="text-slate-900 font-bold mb-2 block tracking-tight">Reviewer Notes</Label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional notes, manual corrections, or observations for this page..."
              className="h-[140px] resize-none bg-slate-50 border-slate-200 shadow-inner"
            />
          </div>

          <div className="pt-5 border-t space-y-4 mt-auto">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600 font-bold uppercase tracking-wider text-[10px]">{job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'} Status</span>
              {page.review?.checked ? (
                <span className="text-emerald-700 font-bold flex items-center bg-emerald-50 px-2 py-1 rounded-sm border border-emerald-100">
                  <CheckCircle2 className="w-4 h-4 mr-1.5"/> Verified
                </span>
              ) : (
                <span className="text-amber-700 font-bold bg-amber-50 px-2 py-1 rounded-sm border border-amber-100">
                  Pending Sign-off
                </span>
              )}
            </div>
            {!readOnly && <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending} className="font-semibold shadow-sm">
                {save.isPending && !page.review?.checked ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : null}
                Save Draft
              </Button>
              <Button
                onClick={() => save.mutate(true)}
                disabled={save.isPending || !allResolved}
                className={cn("font-bold shadow-sm", allResolved ? "bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] text-white" : "opacity-50")}
              >
                {save.isPending && page.review?.checked ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Check className="w-4 h-4 mr-2"/>}
                Verify {job.sourceFormat === 'dxf' ? 'Drawing' : 'Page'}
              </Button>
            </div>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function SignOffPanel({ job, coverage, pages, onDecision, busy }: { job: CadJob, coverage: CadCoverage, pages: CadPage[], onDecision: (d: any) => void, busy: boolean }) {
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerQualification, setReviewerQualification] = useState("");
  const [cadOperatorName, setCadOperatorName] = useState("");
  const [cadOperatorQualification, setCadOperatorQualification] = useState("");
  const [notes, setNotes] = useState("");
  const [declaration, setDeclaration] = useState(false);
  const [cadOperatorDeclaration, setCadOperatorDeclaration] = useState(false);
  const { toast } = useToast();

  const allPagesChecked = pages.length > 0
    && pages.length === job.pageCount
    && pages.every(p => p.review?.checked);
  const allFindingsResolved = pages.every(p => {
    const findings = p.machineAuditFindings || [];
    const resolvedFindingIndexes = new Set(p.review?.resolvedFindingIndexes || []);
    return findings.every((_finding, index) => resolvedFindingIndexes.has(index));
  });

  const reviewerIdentityComplete = Boolean(reviewerName.trim() && reviewerQualification.trim());
  const cadOperatorIdentityComplete = job.sourceFormat !== "dxf"
    || Boolean(cadOperatorName.trim() && cadOperatorQualification.trim());
  const declarationsComplete = declaration
    && (job.sourceFormat !== "dxf" || cadOperatorDeclaration);
  const canApprove = coverage.complete
    && allPagesChecked
    && allFindingsResolved
    && reviewerIdentityComplete
    && cadOperatorIdentityComplete
    && declarationsComplete;

  if (job.status !== "awaiting_review" && job.status !== "done") return null;

  const handleRevise = () => {
    if (!notes.trim()) {
      toast({ title: "Revision requires notes", description: "Please detail what needs to be fixed before requesting a revision.", variant: "destructive" });
      return;
    }
    onDecision({
      decision: "revise",
      notes,
      reviewerName,
      reviewerQualification,
      declaration: false,
      cadOperatorDeclaration: false,
    });
  };

  const handleApprove = () => {
    onDecision({
      decision: "approve",
      notes,
      reviewerName,
      reviewerQualification,
      ...(job.sourceFormat === "dxf" ? {
        cadOperatorName,
        cadOperatorQualification,
      } : {}),
      declaration,
      cadOperatorDeclaration,
    });
  };

  return (
    <Card className="border-[hsl(194_72%_35%_/_0.3)] bg-white mt-10 shadow-lg">
      <CardHeader className="bg-[hsl(194_72%_35%_/_0.04)] border-b pb-5">
        <CardTitle className="text-xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
          <div className="p-2 bg-white rounded-md shadow-sm border border-[hsl(194_72%_35%_/_0.2)]">
            <LockKeyhole className="h-5 w-5 text-[hsl(194_72%_35%)]" />
          </div>
          Official Sign-off
        </CardTitle>
        <CardDescription className="font-medium text-sm text-slate-600 mt-2">
          {job.status === "done" ? "This document set has been formally signed and released for downstream use." : "Record your formal review decision. Both approval and revision require verifiable reviewer identity."}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-6 space-y-7">
          <div className="grid md:grid-cols-2 gap-5">
            <div className="space-y-2.5">
              <Label className="font-bold text-slate-800">Reviewer Legal Name</Label>
              <Input value={reviewerName} onChange={e => setReviewerName(e.target.value)} placeholder="Full legal name" className="bg-slate-50 font-medium" />
            </div>
            <div className="space-y-2.5">
              <Label className="font-bold text-slate-800">Qualification / Title</Label>
              <Input value={reviewerQualification} onChange={e => setReviewerQualification(e.target.value)} placeholder="e.g. Senior Structural Engineer" className="bg-slate-50 font-medium" />
            </div>
          </div>

          {job.sourceFormat === "dxf" && (
            <div className="grid md:grid-cols-2 gap-5">
              <div className="space-y-2.5">
                <Label className="font-bold text-slate-800">CAD Operator Legal Name</Label>
                <Input value={cadOperatorName} onChange={e => setCadOperatorName(e.target.value)} placeholder="Full legal name" className="bg-slate-50 font-medium" />
              </div>
              <div className="space-y-2.5">
                <Label className="font-bold text-slate-800">CAD Operator Qualification / Title</Label>
                <Input value={cadOperatorQualification} onChange={e => setCadOperatorQualification(e.target.value)} placeholder="e.g. Senior CAD Technician" className="bg-slate-50 font-medium" />
              </div>
            </div>
          )}

          <div className="space-y-2.5">
            <Label className="font-bold text-slate-800">Decision Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Required for revisions, optional for approval..." className="min-h-[100px] bg-slate-50 font-medium" />
          </div>

          {job.status === "awaiting_review" && <div className="bg-slate-50 border border-slate-200 p-5 rounded-lg space-y-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Pre-flight Checklist</h4>
            <ul className="text-sm space-y-3 font-semibold">
              <li className="flex items-center gap-3">
                {coverage.complete ? <div className="p-1 rounded-full bg-emerald-100 text-emerald-700 shadow-sm border border-emerald-200"><CheckCircle2 className="w-4 h-4" /></div> : <div className="p-1 rounded-full bg-red-100 text-red-700 shadow-sm border border-red-200"><AlertTriangle className="w-4 h-4" /></div>}
                <span className={coverage.complete ? "text-slate-700" : "text-red-700"}>Automated coverage completeness check passed</span>
              </li>
              <li className="flex items-center gap-3">
                {allPagesChecked ? <div className="p-1 rounded-full bg-emerald-100 text-emerald-700 shadow-sm border border-emerald-200"><CheckCircle2 className="w-4 h-4" /></div> : <div className="p-1 rounded-full bg-amber-100 text-amber-700 shadow-sm border border-amber-200"><AlertTriangle className="w-4 h-4" /></div>}
                <span className={allPagesChecked ? "text-slate-700" : "text-amber-700"}>All {pages.length} {job.sourceFormat === 'dxf' ? 'drawings' : 'pages'} verified manually</span>
              </li>
              <li className="flex items-center gap-3">
                {allFindingsResolved ? <div className="p-1 rounded-full bg-emerald-100 text-emerald-700 shadow-sm border border-emerald-200"><CheckCircle2 className="w-4 h-4" /></div> : <div className="p-1 rounded-full bg-amber-100 text-amber-700 shadow-sm border border-amber-200"><AlertTriangle className="w-4 h-4" /></div>}
                <span className={allFindingsResolved ? "text-slate-700" : "text-amber-700"}>All machine audit findings resolved</span>
              </li>
            </ul>
          </div>}

          {job.status === "awaiting_review" && (
            <div className="space-y-3">
              <div className={cn("flex items-start gap-4 p-4 rounded-lg border transition-colors", declaration ? "bg-emerald-50/50 border-emerald-200" : "bg-blue-50/40 border-blue-100")}>
                <Checkbox id="declaration" checked={declaration} onCheckedChange={(c) => setDeclaration(!!c)} className="mt-1 shadow-sm" />
                <div className="grid gap-1.5">
                  <label htmlFor="declaration" className="text-sm font-bold text-slate-900 cursor-pointer">
                    Declaration of Compliance
                  </label>
                  <p className="text-xs font-medium text-slate-600 leading-relaxed max-w-4xl">
                    I certify that I have reviewed the translated document set against the original source, that all critical engineering parameters remain accurate, and that this document is fit for release.
                  </p>
                </div>
              </div>

              {job.sourceFormat === 'dxf' && (
                <div className={cn("flex items-start gap-4 p-4 rounded-lg border transition-colors", cadOperatorDeclaration ? "bg-emerald-50/50 border-emerald-200" : "bg-blue-50/40 border-blue-100")}>
                  <Checkbox id="cad-declaration" checked={cadOperatorDeclaration} onCheckedChange={(c) => setCadOperatorDeclaration(!!c)} className="mt-1 shadow-sm" />
                  <div className="grid gap-1.5">
                    <label htmlFor="cad-declaration" className="text-sm font-bold text-slate-900 cursor-pointer">
                      CAD Operator Verification
                    </label>
                    <p className="text-xs font-medium text-slate-600 leading-relaxed max-w-4xl">
                      I certify that this DXF opens cleanly in AutoCAD 2018 or newer without repair warnings, and that geometry, layout, title block, and text have been fully inspected and preserved.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <Button
              variant="outline"
              onClick={handleRevise}
              disabled={busy || !reviewerName.trim() || !reviewerQualification.trim()}
              className="border-amber-300 text-amber-800 hover:bg-amber-50 font-bold shadow-sm"
            >
              <MessageSquare className="mr-2 h-4 w-4" />
              {job.status === "done" ? "Start New Revision" : "Request Revision"}
            </Button>
            {job.status === "awaiting_review" && <Button
              onClick={handleApprove}
              disabled={busy || !canApprove}
              className="bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] text-white font-bold shadow-sm"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Sign and Release
            </Button>}
          </div>
        </CardContent>
    </Card>
  );
}

function ReviewHistoryTrail({ history, isDxf }: { history: ReviewHistory[], isDxf: boolean }) {
  return (
    <div className="mt-10 space-y-5">
      <h3 className="text-lg font-bold text-slate-900 border-b border-slate-200 pb-3 tracking-tight">Review Audit Trail</h3>
      <div className="space-y-4">
        {history.map((h, i) => {
          const derivativeApproval = h.decision === "derivative_approve";
          const approval = h.decision === "approve" || derivativeApproval;
          return (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col sm:flex-row sm:items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
            <div className="bg-slate-50 border border-slate-100 text-slate-500 rounded-full p-2.5 self-start shrink-0">
              {approval ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <MessageSquare className="w-5 h-5 text-amber-600" />}
            </div>
            <div className="flex-1 space-y-2 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-bold text-slate-900 truncate text-base">
                  {h.reviewerName} <span className="text-slate-500 font-semibold text-sm">({h.reviewerQualification})</span>
                </p>
                <span className="text-xs font-semibold text-slate-400 shrink-0 uppercase tracking-wider">{new Date(h.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className={cn("font-bold uppercase tracking-wider text-[10px] shadow-none", approval ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200")}>
                  {derivativeApproval ? "Final derivative approved" : h.decision === "derivative_revise" ? "Derivative revision requested" : h.decision === "approve" ? "Approved" : "Revision Requested"}
                </Badge>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Revision {h.revisionCount}</span>
              </div>
              {isDxf && approval && (h.cadOperatorName || h.cadOperatorQualification) && (
                <p className="text-sm font-semibold text-slate-700">
                  CAD Operator: {h.cadOperatorName || "Name unavailable"}
                  {h.cadOperatorQualification && <span className="text-slate-500"> ({h.cadOperatorQualification})</span>}
                </p>
              )}
              {isDxf && approval && h.translatedOutputSha256 && (
                <p className="text-xs font-semibold text-slate-500">
                  Output SHA-256: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{h.translatedOutputSha256.slice(0, 12)}…</code>
                </p>
              )}
              {h.notes && (
                <p className="text-sm font-medium text-slate-700 mt-3 bg-slate-50 p-3 rounded-md border border-slate-100 break-words leading-relaxed">"{h.notes}"</p>
              )}
              {h.declaration && approval && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="inline-flex items-center gap-1.5 font-bold text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-50/80 px-2 py-1.5 rounded-sm border border-emerald-100">
                    <Check className="w-3.5 h-3.5" /> Signed declaration of compliance
                  </div>
                  {h.cadOperatorDeclaration && (
                    <div className="inline-flex items-center gap-1.5 font-bold text-[10px] uppercase tracking-wider text-emerald-700 bg-emerald-50/80 px-2 py-1.5 rounded-sm border border-emerald-100">
                      <Check className="w-3.5 h-3.5" /> Verified CAD operator
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )})}
      </div>
    </div>
  );
}

function QualifiedDerivativeReview({ jobId, derivative, history, active }: { jobId: string; derivative: CadDerivative; history: ReviewHistory[]; active: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [declaration, setDeclaration] = useState(false);
  const { data: auth } = useQuery<CworksAuthStatus>({
    queryKey: ["auth-status"],
    queryFn: async () => (await fetch(`${API}/auth/status`)).json(),
  });
  const derivativeHistory = history.filter(event => event.derivativeId === derivative.id);
  const latestDecision = derivativeHistory[0]?.decision;
  const status: CadDerivativeReviewStatus = derivative.stale
    ? "stale"
    : latestDecision === "derivative_approve"
      ? "approved"
      : latestDecision === "derivative_revise"
        ? "revision_requested"
        : "pending_review";

  const review = useMutation({
    mutationFn: async (decision: "approve" | "revise") => {
      const response = await fetch(`${API}/jobs/${jobId}/cad-derivatives/${derivative.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          notes: notes.trim(),
          declaration: decision === "approve" ? declaration : false,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(result, "Could not save the derivative review"));
      return result;
    },
    onSuccess: (_result, decision) => {
      setNotes(""); setDeclaration(false);
      qc.invalidateQueries({ queryKey: ["job", jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        title: decision === "approve" ? "Final CAD derivative approved" : "Derivative revision requested",
        description: decision === "approve"
          ? "The qualified decision is bound to the displayed derivative checksum."
          : "The submitted derivative remains unreleased.",
      });
    },
    onError: (error: Error) => toast({ title: "Derivative review not saved", description: error.message, variant: "destructive" }),
  });

  const reviewerAuthorized = auth?.derivativeReviewAuthorized === true;
  const canRevise = Boolean(reviewerAuthorized && notes.trim() && !review.isPending && status === "pending_review" && active);
  const canApprove = reviewerAuthorized && declaration && !review.isPending && status === "pending_review" && active;

  return (
    <div className="mt-4 space-y-4 border-t pt-4" data-testid={`derivative-review-${derivative.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">Qualified final derivative review</h4>
        <Badge variant="outline" className={cn(
          "text-[10px] font-bold uppercase tracking-wider",
          status === "approved" && "border-emerald-200 bg-emerald-50 text-emerald-700",
          status === "revision_requested" && "border-amber-200 bg-amber-50 text-amber-700",
          status === "pending_review" && "border-blue-200 bg-blue-50 text-blue-700",
          status === "stale" && "border-red-200 bg-red-50 text-red-700",
        )} data-testid={`text-derivative-review-status-${derivative.id}`}>
          {status === "approved" ? "Approved and released" : status === "revision_requested" ? "Revision requested" : status === "stale" ? "Stale source — blocked" : "Awaiting qualified review"}
        </Badge>
      </div>

      {status === "stale" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm font-medium">This derivative is bound to an earlier source revision. It remains in history but cannot be approved or released. Submit a new derivative from the current draft package.</AlertDescription>
        </Alert>
      )}
      {status === "revision_requested" && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-950">
          <MessageSquare className="h-4 w-4 text-amber-700" />
          <AlertDescription className="text-sm font-medium">This candidate remains in the append-only review history and is not releasable. Use the operator submission form to upload a new source-bound candidate after making the requested corrections.</AlertDescription>
        </Alert>
      )}

      {status === "pending_review" && active && (
        <div className="space-y-4 rounded-lg border border-blue-100 bg-blue-50/30 p-4">
          {!reviewerAuthorized && (
            <Alert variant="destructive">
              <LockKeyhole className="h-4 w-4" />
              <AlertDescription className="text-sm font-medium">Sign in to the workspace with an active owner or admin account before reviewing this derivative. The submitting operator must use a different account.</AlertDescription>
            </Alert>
          )}
          <p className="text-sm font-medium leading-relaxed text-slate-700">Use the candidate's <b>Inspect draft CAD</b> link to review the exact checksum-bound file and the immutable evidence shown above. Your signed-in workspace identity and authorized owner/admin role will be recorded automatically. The operator who submitted this derivative cannot approve it.</p>
          <div className="space-y-2"><Label htmlFor={`derivative-review-notes-${derivative.id}`} className="text-xs font-bold uppercase tracking-wider text-slate-500">Review notes</Label><Textarea id={`derivative-review-notes-${derivative.id}`} value={notes} onChange={event => setNotes(event.target.value)} disabled={review.isPending} className="min-h-20 bg-white" placeholder="Record inspected layouts, tables, geometry, and any required correction." /></div>
          <div className="flex items-start gap-3 rounded-lg border bg-white p-4">
            <Checkbox id={`derivative-review-declaration-${derivative.id}`} checked={declaration} onCheckedChange={value => setDeclaration(value === true)} disabled={review.isPending} />
            <Label htmlFor={`derivative-review-declaration-${derivative.id}`} className="cursor-pointer text-sm font-medium leading-relaxed text-slate-700">I confirm that I am qualified to review this engineering CAD derivative, checked the exact recorded derivative hash and source-bound evidence, checked every review page and finding, and accept responsibility for releasing this derivative.</Label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => review.mutate("revise")} disabled={!canRevise} className="border-amber-300 font-semibold text-amber-800"><MessageSquare className="mr-2 h-4 w-4" />Request derivative revision</Button>
            <Button onClick={() => review.mutate("approve")} disabled={!canApprove} className="bg-[hsl(194_72%_35%)] font-semibold hover:bg-[hsl(194_72%_29%)]">{review.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Approve final derivative</Button>
          </div>
        </div>
      )}

      {!!derivativeHistory.length && (
        <div className="space-y-2" data-testid={`derivative-review-history-${derivative.id}`}>
          {derivativeHistory.map((event, index) => (
            <div key={event.id ?? index} className="rounded-md border bg-slate-50 p-3 text-xs font-medium text-slate-600">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-bold text-slate-800">{event.reviewerName} · {event.reviewerQualification}</span><span>{new Date(event.createdAt).toLocaleString()}</span></div>
              <p className="mt-1"><span className={event.decision === "derivative_approve" ? "font-bold text-emerald-700" : "font-bold text-amber-700"}>{event.decision === "derivative_approve" ? "Approved" : "Revision requested"}</span>{event.notes ? ` — ${event.notes}` : ""}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HybridCadDerivativeWorkflow({ job, binding, derivatives, reviewHistory, submissionOpen }: { job: CadJob; binding: CadDerivativeDraftBinding; derivatives: CadDerivative[]; reviewHistory: ReviewHistory[]; submissionOpen: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const outputInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [operatorQualification, setOperatorQualification] = useState("");
  const [notes, setNotes] = useState("");
  const [applicationOutput, setApplicationOutput] = useState("");
  const [manualResolutions, setManualResolutions] = useState<Record<string, string>>({});
  const [autoCadMajorVersion, setAutoCadMajorVersion] = useState("");
  const [lispSys, setLispSys] = useState("");
  const [hashesVerified, setHashesVerified] = useState(false);
  const [partialEvidenceDiscarded, setPartialEvidenceDiscarded] = useState(false);
  const [savedClosedReopened, setSavedClosedReopened] = useState(false);
  const [reopenedInspectionNotes, setReopenedInspectionNotes] = useState("");
  const [attestation, setAttestation] = useState(false);
  const [error, setError] = useState("");

  const upgradeTableScript = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API}/jobs/${job.id}/upgrade-table-script-evidence`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(result, "Could not upgrade the AutoCAD table script"));
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job", job.id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        title: "Evidence-script upgrade queued",
        description: "A new auditable draft revision will preserve the translations and generate a manifest-bound output script.",
      });
    },
    onError: (upgradeError: Error) => setError(upgradeError.message),
  });

  useEffect(() => {
    setFile(null); setApplicationOutput("");
    setManualResolutions({}); setAttestation(false); setError("");
    setAutoCadMajorVersion(""); setLispSys(""); setHashesVerified(false);
    setPartialEvidenceDiscarded(false); setSavedClosedReopened(false); setReopenedInspectionNotes("");
    if (input.current) input.current.value = "";
    if (outputInput.current) outputInput.current.value = "";
  }, [binding.sourceRevision, binding.sourceOutputSha256, binding.tableScriptSha256, binding.tableManifestSha256]);

  const pick = (next?: File) => {
    if (!next) return;
    if (!/\.dwg$/i.test(next.name)) { setFile(null); return setError("Choose the explicitly saved DWG created from this draft package."); }
    if (next.size > 100 * 1024 * 1024) { setFile(null); return setError("Derivative files must be 100 MB or smaller."); }
    setFile(next); setError("");
  };
  const counterKeys: Array<keyof CadApplicationCounters> = ["expected", "applied", "missing", "ambiguous", "failed", "skipped"];
  const resolutionsComplete = binding.manualRequirementIds.every(id => Boolean(manualResolutions[id]?.trim()));
  const applicationOutputValidation = validateCadApplicationOutput(applicationOutput, binding);
  const pickOutput = async (next?: File) => {
    if (!next) return;
    if (next.size > 1_000_000) {
      setApplicationOutput("");
      return setError("AutoCAD command output must be 1 MB or smaller.");
    }
    setApplicationOutput(await next.text());
    setError("");
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose the completed DXF or DWG derivative.");
      const body = new FormData();
      body.append("file", file);
      body.append("lineageKind", "hybrid_draft_completion");
      body.append("sourceRevision", String(binding.sourceRevision));
      body.append("sourceSha256", binding.sourceSha256);
      body.append("sourceOutputSha256", binding.sourceOutputSha256);
      body.append("preservationReportSha256", binding.preservationReportSha256);
      body.append("ledgerSha256", binding.ledgerSha256);
      body.append("placementManifestSha256", binding.placementManifestSha256);
      body.append("tableScriptSha256", binding.tableScriptSha256);
      body.append("tableManifestSha256", binding.tableManifestSha256);
      body.append("operatorName", operatorName.trim());
      body.append("operatorQualification", operatorQualification.trim());
      body.append("notes", notes.trim());
      body.append("applicationOutput", applicationOutput);
      body.append("manualCoverageResolutions", JSON.stringify(binding.manualRequirementIds.map(requirementId => ({ requirementId, resolution: manualResolutions[requirementId].trim() }))));
      body.append("operationalVerification", JSON.stringify({
        platform: "windows_autocad",
        autoCadMajorVersion: Number(autoCadMajorVersion),
        lispSys: Number(lispSys),
        sourceScriptManifestHashesVerified: hashesVerified,
        partialApplicationEvidenceDisposition: partialEvidenceDiscarded ? "discarded" : "retained",
        savedClosedReopened,
        reopenedInspectionNotes: reopenedInspectionNotes.trim(),
      }));
      body.append("attestation", attestation ? binding.requiredAttestation : "");
      const response = await fetch(`${API}/jobs/${job.id}/cad-derivatives`, { method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(result, "Could not submit the draft-derived CAD file"));
      return result;
    },
    onSuccess: () => {
      setFile(null); setOperatorName(""); setOperatorQualification(""); setNotes("");
      setApplicationOutput("");
      setManualResolutions({}); setAttestation(false); setError("");
      setAutoCadMajorVersion(""); setLispSys(""); setHashesVerified(false);
      setPartialEvidenceDiscarded(false); setSavedClosedReopened(false); setReopenedInspectionNotes("");
      if (input.current) input.current.value = "";
      if (outputInput.current) outputInput.current.value = "";
      qc.invalidateQueries({ queryKey: ["job", job.id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Final derivative submitted for review", description: "The file and operator evidence are bound to the current source, script, and manifest checksums." });
    },
    onError: (submitError: Error) => setError(submitError.message),
  });

  const ready = Boolean(file && operatorName.trim() && operatorQualification.trim() && notes.trim()
    && applicationOutputValidation.valid && resolutionsComplete && Number(autoCadMajorVersion) >= 2021
    && (lispSys === "1" || lispSys === "2") && hashesVerified && partialEvidenceDiscarded
    && savedClosedReopened && reopenedInspectionNotes.trim().length >= 3
    && attestation && !submit.isPending);
  const hybridDerivatives = derivatives.filter(derivative => derivative.lineageKind === "hybrid_draft_completion");

  return (
    <Card className="border-blue-200 bg-white shadow-sm" data-testid="card-hybrid-derivative-workflow">
      <CardHeader className="border-b bg-blue-50/50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle className="text-lg font-bold text-slate-900">Final CAD derivative submission and review</CardTitle><CardDescription className="mt-1 max-w-3xl text-sm font-medium">The machine-clean DXF remains a draft. Submit the separately saved AutoCAD derivative with actual application evidence; a qualified reviewer must approve that exact derivative before release.</CardDescription></div>
          <Badge variant="outline" className="border-blue-200 bg-white text-[10px] font-bold uppercase tracking-wider text-blue-700">Draft source revision {binding.sourceRevision}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 p-5">
        <div className="grid gap-3 rounded-lg border bg-slate-50 p-4 text-xs font-medium text-slate-600 sm:grid-cols-2" data-testid="draft-derivative-binding">
          <p>Source revision: <b className="text-slate-900">{binding.sourceRevision}</b></p>
          <p>Expected script applications: <b className="text-slate-900">{binding.expectedCounters.expected}</b> across {binding.tableTargetCount} targets</p>
          <p className="break-all">Draft source SHA-256: <code className="font-mono text-slate-800">{binding.sourceOutputSha256}</code></p>
          <p className="break-all">Table script SHA-256: <code className="font-mono text-slate-800">{binding.tableScriptSha256}</code></p>
          <p className="break-all sm:col-span-2">Table manifest SHA-256: <code className="font-mono text-slate-800">{binding.tableManifestSha256}</code></p>
          <p className="break-all">Original source SHA-256: <code className="font-mono text-slate-800">{binding.sourceSha256}</code></p>
          <p className="break-all">Ledger SHA-256: <code className="font-mono text-slate-800">{binding.ledgerSha256}</code></p>
          <p className="break-all sm:col-span-2">Placement manifest SHA-256: <code className="font-mono text-slate-800">{binding.placementManifestSha256}</code></p>
          <p className="sm:col-span-2">Independent audit model: <b className="text-slate-900">{binding.independentAuditModel}</b></p>
        </div>
        {job.status === "awaiting_review" && !binding.submissionAllowed && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="font-medium">
              {!binding.applicationOutputCaptureSupported
                ? <span>This draft predates manifest-bound command output. Its existing script and candidates remain in history, but they cannot be approved under the captured-output requirement. <Button type="button" variant="outline" size="sm" className="ml-2 border-red-300 bg-white text-red-800" onClick={() => upgradeTableScript.mutate()} disabled={upgradeTableScript.isPending} data-testid="button-upgrade-table-script-evidence">{upgradeTableScript.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Create upgraded draft revision</Button></span>
                : <>Derivative submission is blocked by {binding.machineDefectCount} unresolved machine translation, patch, or independent-audit defect{binding.machineDefectCount === 1 ? "" : "s"}. Resolve those source defects before creating a final CAD derivative.</>}
            </AlertDescription>
          </Alert>
        )}

        {submissionOpen && <div className="space-y-4 rounded-xl border p-5">
          <div className="space-y-2"><Label htmlFor="hybrid-derivative-file" className="text-xs font-bold uppercase tracking-wider text-slate-500">Completed derivative DWG</Label><Input ref={input} id="hybrid-derivative-file" type="file" accept=".dwg,application/acad" disabled={submit.isPending} onChange={event => pick(event.target.files?.[0])} data-testid="input-hybrid-derivative-file" />{file && <p className="text-xs font-semibold text-slate-600">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}</div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="hybrid-operator-name" className="text-xs font-bold uppercase tracking-wider text-slate-500">CAD operator legal name</Label><Input id="hybrid-operator-name" value={operatorName} onChange={event => setOperatorName(event.target.value)} disabled={submit.isPending} /></div>
            <div className="space-y-2"><Label htmlFor="hybrid-operator-qualification" className="text-xs font-bold uppercase tracking-wider text-slate-500">CAD operator qualification</Label><Input id="hybrid-operator-qualification" value={operatorQualification} onChange={event => setOperatorQualification(event.target.value)} disabled={submit.isPending} /></div>
          </div>
          <div className="space-y-3 rounded-lg border bg-slate-50 p-4">
            <div><h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Complete AutoCAD command output</h4><p className="mt-1 text-sm font-medium text-slate-600">Paste the complete CWORKS_APPLY_TABLE_TRANSLATIONS output or attach a text file. The server reads every reported counter and verifies it against the bound manifest.</p></div>
            <Input ref={outputInput} type="file" accept=".txt,.log,text/plain" onChange={event => void pickOutput(event.target.files?.[0])} disabled={submit.isPending} data-testid="input-application-output-file" />
            <Textarea value={applicationOutput} onChange={event => setApplicationOutput(event.target.value)} disabled={submit.isPending} className="min-h-32 bg-white font-mono text-xs" placeholder="Paste the complete AutoCAD command output here…" data-testid="textarea-application-output" />
            {applicationOutput.trim() && (
              <p
                role={applicationOutputValidation.valid ? "status" : "alert"}
                className={cn("rounded-md border p-3 text-sm font-semibold", applicationOutputValidation.valid ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900")}
                data-testid="status-application-output-validation"
              >
                {applicationOutputValidation.valid ? "AutoCAD output matches this draft manifest and all seven counters are successful." : applicationOutputValidation.message}
              </p>
            )}
          </div>
          {!!binding.manualRequirementIds.length && <div className="space-y-3"><h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Explicit manual coverage resolutions</h4>{binding.manualRequirementIds.map(requirementId => <div key={requirementId} className="rounded-lg border bg-slate-50 p-3"><Label htmlFor={`manual-resolution-${requirementId}`} className="break-all font-bold text-slate-800">{requirementId}</Label><Textarea id={`manual-resolution-${requirementId}`} value={manualResolutions[requirementId] || ""} onChange={event => setManualResolutions(current => ({ ...current, [requirementId]: event.target.value }))} disabled={submit.isPending} placeholder="State what was inspected, changed or intentionally preserved, and how it was verified." className="mt-2 min-h-20 bg-white" /></div>)}</div>}
          <div className="space-y-4 rounded-lg border bg-slate-50 p-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">Windows AutoCAD application proof</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="autocad-major-version">AutoCAD major version</Label><Input id="autocad-major-version" type="number" min="2021" max="2100" step="1" value={autoCadMajorVersion} onChange={event => setAutoCadMajorVersion(event.target.value)} disabled={submit.isPending} placeholder="2024" /></div>
              <div className="space-y-2"><Label htmlFor="autocad-lispsys">LISPSYS value</Label><Select value={lispSys} onValueChange={setLispSys} disabled={submit.isPending}><SelectTrigger id="autocad-lispsys"><SelectValue placeholder="Select verified value" /></SelectTrigger><SelectContent><SelectItem value="1">1 — Unicode</SelectItem><SelectItem value="2">2 — Unicode</SelectItem></SelectContent></Select></div>
            </div>
            <div className="space-y-3">
              <div className="flex items-start gap-3"><Checkbox id="hybrid-hashes-verified" checked={hashesVerified} onCheckedChange={value => setHashesVerified(value === true)} /><Label htmlFor="hybrid-hashes-verified" className="cursor-pointer leading-relaxed">I verified the displayed source, script, and table-manifest SHA-256 values before applying the script.</Label></div>
              <div className="flex items-start gap-3"><Checkbox id="hybrid-partial-discarded" checked={partialEvidenceDiscarded} onCheckedChange={value => setPartialEvidenceDiscarded(value === true)} /><Label htmlFor="hybrid-partial-discarded" className="cursor-pointer leading-relaxed">The script reported exact successful counters; any file from an aborted, failed, ambiguous, missing, skipped, or partial run was closed without saving and discarded.</Label></div>
              <div className="flex items-start gap-3"><Checkbox id="hybrid-reopened" checked={savedClosedReopened} onCheckedChange={value => setSavedClosedReopened(value === true)} /><Label htmlFor="hybrid-reopened" className="cursor-pointer leading-relaxed">I saved the derivative DWG, closed it, reopened that saved file, and inspected the reopened drawing.</Label></div>
            </div>
            <div className="space-y-2"><Label htmlFor="hybrid-reopen-notes">Reopened derivative inspection</Label><Textarea id="hybrid-reopen-notes" value={reopenedInspectionNotes} onChange={event => setReopenedInspectionNotes(event.target.value)} disabled={submit.isPending} placeholder="Record the layouts and complex tables inspected after reopening, including Unicode text and table formatting." className="min-h-20 bg-white" /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="hybrid-operator-notes" className="text-xs font-bold uppercase tracking-wider text-slate-500">Operator notes</Label><Textarea id="hybrid-operator-notes" value={notes} onChange={event => setNotes(event.target.value)} disabled={submit.isPending} className="min-h-20" placeholder="Describe application, AUDIT results, visual inspection, and saved file format." /></div>
          <div className="flex items-start gap-3 rounded-lg border bg-slate-50 p-4"><Checkbox id="hybrid-operator-attestation" checked={attestation} onCheckedChange={value => setAttestation(value === true)} disabled={submit.isPending} /><Label htmlFor="hybrid-operator-attestation" className="cursor-pointer text-sm font-medium leading-relaxed text-slate-700">{binding.requiredAttestation}</Label></div>
          {error && <p role="alert" className="rounded-md border border-red-100 bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
          <div className="flex justify-end"><Button onClick={() => submit.mutate()} disabled={!ready} className="bg-[hsl(194_72%_35%)] font-semibold hover:bg-[hsl(194_72%_29%)]" data-testid="button-submit-hybrid-derivative">{submit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Submit for qualified review</Button></div>
        </div>}

        <div className="space-y-3">
          <h3 className="text-sm font-bold text-slate-900">Submitted final derivative candidates</h3>
          {!hybridDerivatives.length && <div className="rounded-xl border-2 border-dashed px-5 py-8 text-center text-sm font-semibold text-slate-500">No derivative has been submitted for this draft package.</div>}
          {hybridDerivatives.map(derivative => {
            const evidenceCurrent = binding.sourceRevision === job.revisionCount
              && derivative.source.revision === binding.sourceRevision
              && derivative.source.translatedOutputSha256 === binding.sourceOutputSha256
              && derivative.evidence?.sourceSha256 === binding.sourceSha256
              && derivative.evidence?.preservationReportSha256 === binding.preservationReportSha256
              && derivative.evidence?.ledgerSha256 === binding.ledgerSha256
              && derivative.evidence?.placementManifestSha256 === binding.placementManifestSha256
              && derivative.evidence?.tableScriptSha256 === binding.tableScriptSha256
              && derivative.evidence?.tableManifestSha256 === binding.tableManifestSha256
              && derivative.evidence?.independentAuditModel === binding.independentAuditModel
              && derivative.evidence?.machineDefectCount === binding.machineDefectCount
              && derivative.evidence?.operationalVerification?.platform === "windows_autocad"
              && Number(derivative.evidence?.operationalVerification?.autoCadMajorVersion) >= 2021
              && [1, 2].includes(Number(derivative.evidence?.operationalVerification?.lispSys))
              && derivative.evidence?.operationalVerification?.sourceScriptManifestHashesVerified === true
              && derivative.evidence?.operationalVerification?.partialApplicationEvidenceDisposition === "discarded"
              && derivative.evidence?.operationalVerification?.savedClosedReopened === true
              && Boolean(derivative.evidence?.operationalVerification?.reopenedInspectionNotes?.trim())
              && (derivative.evidence?.format === "cworks-hybrid-derivative-evidence-v1"
                || (derivative.evidence?.format === "cworks-hybrid-derivative-evidence-v2"
                  && Boolean(derivative.evidence?.applicationOutput?.text)
                  && Boolean(derivative.evidence?.applicationOutput?.sha256)))
              && counterKeys.every(key => derivative.evidence?.counters?.[key] === binding.expectedCounters[key])
              && JSON.stringify((derivative.evidence?.manualCoverageResolutions || []).map(item => item.requirementId).sort())
                === JSON.stringify([...binding.manualRequirementIds].sort());
            const candidateStale = derivative.stale || !evidenceCurrent;
            const released = !candidateStale
              && job.status === "done"
              && reviewHistory.some(event => event.derivativeId === derivative.id && event.decision === "derivative_approve");
            const legacyOutputMissing = derivative.evidence?.format === "cworks-hybrid-derivative-evidence-v1"
              && !derivative.evidence?.applicationOutput;
            return <div key={derivative.id} className={cn("rounded-xl border bg-white p-4 shadow-sm", candidateStale && "border-red-200 bg-red-50/20")} data-testid={`card-hybrid-derivative-${derivative.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-bold text-slate-900">{derivative.originalFilename}</p><p className="mt-1 text-xs font-semibold text-slate-500">{derivative.operatorName} · {derivative.operatorQualification}</p></div><div className="flex flex-wrap items-center justify-end gap-2">{!released && !candidateStale && derivative.draftDownloadUrl && <a href={derivative.draftDownloadUrl} download data-testid={`link-inspect-draft-derivative-${derivative.id}`}><Button variant="outline" size="sm" className="border-blue-200 bg-blue-50 font-semibold text-blue-800 hover:bg-blue-100"><Download className="mr-1.5 h-3.5 w-3.5" />Inspect draft {derivative.format.toUpperCase()}</Button></a>}{!released && <Badge variant="outline" className="border-blue-200 bg-blue-50 text-[10px] font-bold uppercase text-blue-700">Final release locked</Badge>}</div></div>
            <div className="mt-3 grid gap-2 rounded-md border bg-slate-50 p-3 text-xs font-medium text-slate-600 sm:grid-cols-2"><p>Bound source revision: <b>{derivative.source.revision}</b></p><p className="break-all">Derivative SHA-256: <code className="font-mono text-slate-800">{derivative.sha256}</code></p><p className="break-all">Draft source SHA-256: <code className="font-mono">{derivative.source.translatedOutputSha256}</code></p><p className="break-all">Script SHA-256: <code className="font-mono">{derivative.evidence?.tableScriptSha256 || "Not recorded"}</code></p><p className="break-all sm:col-span-2">Table manifest SHA-256: <code className="font-mono">{derivative.evidence?.tableManifestSha256 || "Not recorded"}</code></p><p className="break-all">Ledger SHA-256: <code className="font-mono">{derivative.evidence?.ledgerSha256 || "Not recorded"}</code></p><p className="break-all">Placement manifest SHA-256: <code className="font-mono">{derivative.evidence?.placementManifestSha256 || "Not recorded"}</code></p></div>
            {derivative.evidence?.counters && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-6">{Object.entries(derivative.evidence.counters).map(([label, value]) => <div key={label} className="rounded-md border p-2 text-center"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-lg font-black text-slate-800">{value}</p></div>)}</div>}
            {derivative.evidence?.applicationOutput && <div className="mt-3 space-y-2 rounded-md border bg-slate-950 p-3 text-slate-100" data-testid={`application-output-${derivative.id}`}><div className="flex flex-wrap justify-between gap-2 text-xs font-bold"><span>Preserved CWORKS_APPLY_TABLE_TRANSLATIONS output</span><span className="break-all font-mono text-slate-400">SHA-256 {derivative.evidence.applicationOutput.sha256}</span></div><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{derivative.evidence.applicationOutput.text}</pre></div>}
            {legacyOutputMissing && !released && <Alert className="mt-3 border-amber-200 bg-amber-50 text-amber-950"><AlertTriangle className="h-4 w-4 text-amber-700" /><AlertDescription className="font-medium">This candidate predates captured AutoCAD command output. It remains in history, but cannot be approved. If the bound script also predates manifest-bound output, create an upgraded draft revision above before running the new script and submitting a replacement candidate.</AlertDescription></Alert>}
            {derivative.evidence?.operationalVerification && <div className="mt-3 rounded-md border bg-slate-50 p-3 text-sm font-medium text-slate-700"><p className="font-bold text-slate-900">Windows AutoCAD {derivative.evidence.operationalVerification.autoCadMajorVersion} · LISPSYS {derivative.evidence.operationalVerification.lispSys}</p><p className="mt-1">Hashes verified · partial artifacts discarded · saved, closed, and reopened</p><p className="mt-2">{derivative.evidence.operationalVerification.reopenedInspectionNotes}</p></div>}
            {!!derivative.evidence?.manualCoverageResolutions?.length && <div className="mt-3 space-y-2"><p className="text-xs font-bold uppercase tracking-wider text-slate-500">Manual coverage resolutions</p>{derivative.evidence.manualCoverageResolutions.map(item => <p key={item.requirementId} className="rounded-md border bg-slate-50 p-2 text-sm font-medium text-slate-700"><b>{item.requirementId}:</b> {item.resolution}</p>)}</div>}
            <QualifiedDerivativeReview jobId={job.id} derivative={{ ...derivative, stale: candidateStale }} history={reviewHistory} active={submissionOpen && !legacyOutputMissing} />
            {released && <div className="mt-3 flex flex-wrap justify-end gap-2"><a href={derivative.lineageReportUrl} download><Button variant="outline" size="sm"><FileText className="mr-1.5 h-3.5 w-3.5" />Released evidence report</Button></a><a href={derivative.downloadUrl} download><Button variant="outline" size="sm"><Download className="mr-1.5 h-3.5 w-3.5" />Download released CAD</Button></a></div>}
          </div>;
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function HumanAdjustedDerivatives({ job, derivatives, sourceSha256 }: { job: CadJob; derivatives: CadDerivative[]; sourceSha256?: string | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [operatorName, setOperatorName] = useState("");
  const [operatorQualification, setOperatorQualification] = useState("");
  const [notes, setNotes] = useState("");
  const [attestation, setAttestation] = useState(false);
  const [error, setError] = useState("");
  const sourceRevision = job.approvedRevision ?? job.revisionCount;
  const touchupDerivatives = derivatives.filter(derivative => derivative.lineageKind !== "hybrid_draft_completion");

  const pick = (next?: File) => {
    if (!next) return;
    if (!/\.(dxf|dwg)$/i.test(next.name)) {
      setFile(null);
      return setError("Choose a DXF or DWG file containing the human-adjusted drawing.");
    }
    if (next.size > 100 * 1024 * 1024) {
      setFile(null);
      return setError("Derivative files must be 100 MB or smaller.");
    }
    setError("");
    setFile(next);
  };

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a DXF or DWG derivative to upload.");
      const body = new FormData();
      body.append("file", file);
      body.append("operatorName", operatorName.trim());
      body.append("operatorQualification", operatorQualification.trim());
      body.append("notes", notes.trim());
      body.append("attestation", attestation ? CAD_DERIVATIVE_ATTESTATION : "");
      const response = await fetch(`${API}/jobs/${job.id}/cad-derivatives`, { method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(result, "Could not save the human-adjusted derivative"));
      return result;
    },
    onSuccess: () => {
      setFile(null); setOperatorName(""); setOperatorQualification(""); setNotes(""); setAttestation(false); setError("");
      if (input.current) input.current.value = "";
      qc.invalidateQueries({ queryKey: ["job", job.id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Human-adjusted derivative recorded", description: "Its checksum and approved-source lineage are now attached to this job." });
    },
    onError: (uploadError: Error) => setError(uploadError.message),
  });

  const ready = Boolean(file && operatorName.trim() && operatorQualification.trim() && notes.trim() && attestation && !upload.isPending);

  return (
    <Card className="border-slate-200 bg-white shadow-sm" data-testid="card-human-adjusted-derivatives">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base font-bold text-slate-900">Human-adjusted CAD derivatives</CardTitle>
            <CardDescription className="mt-1 max-w-3xl text-sm font-medium">Record a DXF or DWG changed by an operator after approval. Each file receives its own SHA-256 and lineage to the approved native DXF.</CardDescription>
          </div>
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-bold uppercase tracking-wider text-emerald-700" data-testid="text-derivative-source-revision">Approved source revision {sourceRevision}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <Alert className="border-amber-200 bg-amber-50 text-amber-950" data-testid="alert-derivative-preservation-scope">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <AlertDescription className="text-sm font-medium leading-relaxed"><b>Preservation proof does not transfer.</b> It remains attached only to the approved machine-clean DXF. A human-adjusted derivative is separately checksummed and traceable, but is not covered by that preservation proof.</AlertDescription>
        </Alert>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4 rounded-xl border bg-slate-50/40 p-5">
            <div className="space-y-2">
              <Label htmlFor="derivative-file" className="text-xs font-bold uppercase tracking-wider text-slate-500">Adjusted DXF or DWG</Label>
              <Input ref={input} id="derivative-file" type="file" accept=".dxf,.dwg,application/dxf,image/vnd.dxf,application/acad" disabled={upload.isPending} onChange={e => pick(e.target.files?.[0])} className="bg-white" data-testid="input-derivative-file" />
              {file && <p className="text-xs font-semibold text-slate-600" data-testid="text-derivative-selected-file">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="derivative-name" className="text-xs font-bold uppercase tracking-wider text-slate-500">Operator name</Label><Input id="derivative-name" value={operatorName} onChange={e => setOperatorName(e.target.value)} disabled={upload.isPending} placeholder="Full name" className="bg-white" data-testid="input-derivative-operator-name" /></div>
              <div className="space-y-2"><Label htmlFor="derivative-qualification" className="text-xs font-bold uppercase tracking-wider text-slate-500">Qualification</Label><Input id="derivative-qualification" value={operatorQualification} onChange={e => setOperatorQualification(e.target.value)} disabled={upload.isPending} placeholder="Role, licence, or competency" className="bg-white" data-testid="input-derivative-operator-qualification" /></div>
            </div>
            <div className="space-y-2"><Label htmlFor="derivative-notes" className="text-xs font-bold uppercase tracking-wider text-slate-500">Adjustment notes</Label><Textarea id="derivative-notes" value={notes} onChange={e => setNotes(e.target.value)} disabled={upload.isPending} placeholder="Describe the manual changes and their purpose." className="min-h-24 bg-white" data-testid="textarea-derivative-notes" /></div>
            <div className="flex items-start gap-3 rounded-lg border bg-white p-4">
              <Checkbox id="derivative-attestation" checked={attestation} onCheckedChange={value => setAttestation(value === true)} disabled={upload.isPending} data-testid="checkbox-derivative-attestation" />
              <Label htmlFor="derivative-attestation" className="cursor-pointer text-sm font-medium leading-relaxed text-slate-700">{CAD_DERIVATIVE_ATTESTATION}</Label>
            </div>
            {error && <p role="alert" className="rounded-md border border-red-100 bg-red-50 p-3 text-sm font-semibold text-red-700" data-testid="text-derivative-upload-error">{error}</p>}
            <p className="break-all text-xs font-medium text-slate-500" data-testid="text-derivative-source-lineage">Lineage source: approved revision {sourceRevision}{sourceSha256 ? <> · SHA-256 <code className="font-mono text-slate-700">{sourceSha256}</code></> : null}</p>
            <div className="flex justify-end"><Button onClick={() => upload.mutate()} disabled={!ready} className="bg-[hsl(194_72%_35%)] font-semibold hover:bg-[hsl(194_72%_29%)]" data-testid="button-upload-derivative">{upload.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}{upload.isPending ? "Recording derivative" : "Record derivative"}</Button></div>
          </div>
          <div className="space-y-3">
            <div><h3 className="text-sm font-bold text-slate-900">Recorded derivatives</h3><p className="mt-1 text-xs font-medium text-slate-500">Independent files with checksums and approved-source lineage.</p></div>
            {!touchupDerivatives.length && <div className="rounded-xl border-2 border-dashed px-5 py-10 text-center text-sm font-semibold text-slate-500" data-testid="text-derivatives-empty">No human-adjusted derivatives recorded.</div>}
            {touchupDerivatives.map(derivative => {
              return <div key={derivative.id} className="rounded-xl border bg-white p-4 shadow-sm" data-testid={`card-derivative-${derivative.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate text-sm font-bold" data-testid={`text-derivative-filename-${derivative.id}`}>{derivative.originalFilename}</p><p className="mt-1 text-xs font-semibold text-slate-500" data-testid={`text-derivative-operator-${derivative.id}`}>{derivative.operatorName} · {derivative.operatorQualification}</p></div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <a href={derivative.lineageReportUrl} download data-testid={`link-download-derivative-report-${derivative.id}`}><Button variant="outline" size="sm" className="font-semibold"><FileText className="mr-1.5 h-3.5 w-3.5" />Lineage report</Button></a>
                    <a href={derivative.downloadUrl} download data-testid={`link-download-derivative-${derivative.id}`}><Button variant="outline" size="sm" className="font-semibold"><Download className="mr-1.5 h-3.5 w-3.5" />Download CAD</Button></a>
                  </div>
                </div>
                <div className="mt-3 rounded-md border bg-slate-50 p-3 text-xs font-medium text-slate-600"><p data-testid={`text-derivative-revision-${derivative.id}`}>Source: approved revision {derivative.source.revision}</p><p className="mt-1 break-all">Approved source SHA-256: <code className="font-mono">{derivative.source.translatedOutputSha256}</code></p><p className="mt-1 break-all" data-testid={`text-derivative-sha256-${derivative.id}`}>Derivative SHA-256: <code className="font-mono">{derivative.sha256}</code></p></div>
                <p className="mt-3 text-sm font-medium text-slate-700" data-testid={`text-derivative-notes-${derivative.id}`}>{derivative.operatorNotes}</p>
                <div className="mt-3 flex items-center gap-2"><Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] font-bold uppercase text-emerald-700"><Check className="mr-1 h-3 w-3" />Operator attested</Badge><span className="text-[10px] font-bold uppercase text-slate-400" data-testid={`text-derivative-created-${derivative.id}`}>{new Date(derivative.createdAt).toLocaleString()}</span></div>
              </div>;
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
function JobDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedPageId, setSelectedPageId] = useState<number | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<{
    job: CadJob;
    pages: CadPage[];
    coverage: CadCoverage;
    reviewHistory: ReviewHistory[];
    derivatives?: CadDerivative[];
    retryMetadata?: RetryMetadata;
    downloadAvailability?: DownloadAvailability;
  }>({
    queryKey: ["job", id],
    queryFn: async () => { const r = await fetch(`${API}/jobs/${id}`); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(apiError(b, "Could not load job")); return b; },
    refetchInterval: q => { const s = q.state.data?.job?.status; return s === "queued" || s === "running" || s === "revising" ? 4000 : false; }
  });
  const { data: cadDerivativeRequirements, error: cadDerivativeRequirementsError, isLoading: cadDerivativeRequirementsLoading } = useQuery<CadDerivativeDraftBinding>({
    queryKey: ["job", id, "cad-derivative-requirements", data?.job.revisionCount],
    enabled: data?.job.sourceFormat === "dxf"
      && data?.job.status === "awaiting_review"
      && data?.coverage.hybridPending === true,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`${API}/jobs/${id}/cad-derivative-requirements`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "Could not load derivative submission requirements"));
      return body;
    },
  });

  const feedback = useMutation({
    mutationFn: async (data: {
      decision: "approve" | "revise";
      notes: string;
      reviewerName: string;
      reviewerQualification: string;
      cadOperatorName?: string;
      cadOperatorQualification?: string;
      declaration: boolean;
      cadOperatorDeclaration: boolean;
    }) => {
      const r = await fetch(`${API}/jobs/${id}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(b, "Could not save review decision"));
      return b;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job", id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({ title: "Review decision saved" });
    },
    onError: (e: Error) => toast({ title: "Review not saved", description: e.message, variant: "destructive" })
  });

  const automaticRepair = useMutation({
    mutationFn: async () => {
      const isNativeDxf = job.sourceFormat === "dxf";
      const r = await fetch(`${API}/jobs/${id}/${isNativeDxf ? "correct-unresolved" : "fix-unresolved"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isNativeDxf ? {
          consentToTargetedDxfCorrection: true,
          expectedSourceRevision: job.revisionCount,
        } : {}),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(b, "Could not start the repair pass"));
      return b;
    },
    onSuccess: () => {
      setSelectedPageId(null);
      qc.invalidateQueries({ queryKey: ["job", id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        title: job.sourceFormat === "dxf" ? "Targeted DXF correction queued" : "Repair pass queued",
        description: job.sourceFormat === "dxf"
          ? "Saved translations and review evidence will be reused. AI work is limited to affected text before the audit runs again; geometry is not changed and this is not a full restart."
          : "A new draft revision will retry unresolved placements and unchecked findings, then run an independent audit.",
      });
    },
    onError: (e: Error) => toast({
      title: job.sourceFormat === "dxf" ? "Targeted DXF correction not started" : "Repair pass not started",
      description: e.message,
      variant: "destructive",
    }),
  });

  const restorePrevious = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API}/jobs/${id}/restore-previous-revision`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(body, "Could not restore the previous revision"));
      return body;
    },
    onSuccess: () => {
      setSelectedPageId(null);
      qc.invalidateQueries({ queryKey: ["job", id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        title: "Previous translations queued",
        description: "They will be restored as a new draft and must pass placement, audit, and review again.",
      });
    },
    onError: (error: Error) => toast({
      title: "Previous revision not restored",
      description: error.message,
      variant: "destructive",
    }),
  });

  const retry = useMutation({
    mutationFn: async (mode: "resume" | "full_restart") => {
      const r = await fetch(`${API}/jobs/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          confirmRepeatAiUsage: mode === "full_restart",
        }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(b, "Could not retry translation"));
      return { ...b, mode };
    },
    onSuccess: ({ mode }) => {
      qc.invalidateQueries({ queryKey: ["job", id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast({
        title: mode === "resume" ? "Translation resume queued" : "Full translation restart queued",
        description: mode === "resume"
          ? "Validated saved checkpoints will be restored before unfinished work continues."
          : "Saved checkpoints were discarded. Translation and audit work will run again.",
      });
    },
    onError: (e: Error) => toast({ title: "Could not retry translation", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async () => { const r = await fetch(`${API}/jobs/${id}`, { method: "DELETE" }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(apiError(b, "Could not delete job")); },
    onSuccess: () => { qc.removeQueries({ queryKey: ["job", id] }); qc.invalidateQueries({ queryKey: ["jobs"] }); toast({ title: "Drawing job deleted", description: "Its saved translations and private files are being removed." }); onBack(); },
    onError: (e: Error) => toast({ title: "Could not delete job", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-[hsl(194_72%_35%)]" /></div>;
  if (isError || !data) return <Card><CardContent className="py-12 text-center"><AlertTriangle className="mx-auto h-8 w-8 text-red-500" /><p className="mt-3 text-sm font-bold">This drawing job could not be loaded.</p><Button onClick={() => refetch()} variant="outline" size="sm" className="mt-4 font-semibold">Try again</Button></CardContent></Card>;

  const { job, pages, coverage } = data;
  const retryMetadata = data.retryMetadata;
  const downloadAvailability = data.downloadAvailability;
  const reviewHistory = data.reviewHistory || [];
  const derivatives = data.job.derivatives || data.derivatives || [];
  const latestHybridDerivative = [...derivatives].reverse().find(derivative => derivative.lineageKind === "hybrid_draft_completion");
  const recordedEvidence = latestHybridDerivative?.evidence;
  const recordedBinding: CadDerivativeDraftBinding | null = latestHybridDerivative
    && recordedEvidence
    && (recordedEvidence.format === "cworks-hybrid-derivative-evidence-v1"
      || recordedEvidence.format === "cworks-hybrid-derivative-evidence-v2")
    && typeof recordedEvidence.sourceSha256 === "string"
    && typeof recordedEvidence.preservationReportSha256 === "string"
    && typeof recordedEvidence.ledgerSha256 === "string"
    && typeof recordedEvidence.placementManifestSha256 === "string"
    && typeof recordedEvidence.tableScriptSha256 === "string"
    && typeof recordedEvidence.tableManifestSha256 === "string"
    && recordedEvidence.counters
    ? {
        format: "cworks-hybrid-derivative-requirements-v1",
        lineageKind: "hybrid_draft_completion",
        sourceRevision: latestHybridDerivative.source.revision,
        sourceSha256: recordedEvidence.sourceSha256,
        sourceOutputSha256: latestHybridDerivative.source.translatedOutputSha256,
        preservationReportSha256: recordedEvidence.preservationReportSha256,
        ledgerSha256: recordedEvidence.ledgerSha256,
        placementManifestSha256: recordedEvidence.placementManifestSha256,
        tableScriptSha256: recordedEvidence.tableScriptSha256,
        tableManifestSha256: recordedEvidence.tableManifestSha256,
        tableTargetCount: recordedEvidence.tableTargetCount || 0,
        expectedCounters: recordedEvidence.counters,
        manualRequirementIds: recordedEvidence.manualCoverageResolutions?.map(item => item.requirementId) || [],
        machineDefectCount: recordedEvidence.machineDefectCount || 0,
        independentAuditModel: recordedEvidence.independentAuditModel || "Recorded independent audit",
        applicationOutputCaptureSupported:
          recordedEvidence.format === "cworks-hybrid-derivative-evidence-v2",
        submissionAllowed: false,
        requiredAttestation: latestHybridDerivative.operatorAttestation,
      }
    : null;
  const cadDerivativeDraft = cadDerivativeRequirements || recordedBinding;
  const working = ["queued", "running", "revising"].includes(job.status);
  const reviewReady = job.status === "awaiting_review" || job.status === "done";
  const download = (kind: string) => `${API}/jobs/${id}/${kind}`;

  const canDownloadFinal = job.status === "done"
    && job.approvedRevision === job.revisionCount
    && Boolean(job.approvedAt);
  const canDownloadOriginal = downloadAvailability?.original === true;
  const canDownloadSummary = canDownloadFinal && downloadAvailability?.summary === true;
  const canDownloadOutput = canDownloadFinal && downloadAvailability?.output === true;

  const selectedPageIndex = pages.findIndex(p => p.id === selectedPageId);
  const selectedPage = selectedPageIndex >= 0 ? pages[selectedPageIndex] : null;
  const prevPage = selectedPageIndex > 0 ? pages[selectedPageIndex - 1] : null;
  const nextPage = selectedPageIndex < pages.length - 1 ? pages[selectedPageIndex + 1] : null;
  const unresolvedFindingCount = pages.reduce((sum, page) => {
    const resolved = new Set(page.review?.resolvedFindingIndexes || []);
    return sum + (page.machineAuditFindings || []).filter((_finding, index) => !resolved.has(index)).length;
  }, 0);
  const canFixUnresolved = job.status === "awaiting_review"
    && (!coverage.complete || unresolvedFindingCount > 0)
    && (job.sourceFormat !== "dxf"
      || coverage.unresolvedLineCount > 0
      || unresolvedFindingCount > 0);
  const startAutomaticRepair = () => {
    if (!canFixUnresolved || automaticRepair.isPending) return;
    const isNativeDxf = job.sourceFormat === "dxf";
    const details = [
      !coverage.complete ? `${coverage.unresolvedLineCount} unresolved placement${coverage.unresolvedLineCount === 1 ? "" : "s"}` : null,
      unresolvedFindingCount ? `${unresolvedFindingCount} unchecked audit finding${unresolvedFindingCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(" and ");
    const confirmation = isNativeDxf
      ? `Create a new targeted native DXF draft revision for ${details}? This uses saved translations and review evidence, incurs AI work for affected text, and runs the audit again. Geometry is not altered, and this is not a full translation restart. Text fit is not guaranteed; review remains required. Approval and final downloads will remain locked until the new revision is reviewed.`
      : `Create a new draft revision to fix ${details}? Correct translations will be preserved where they can be identified safely. Approval and final downloads will remain locked until the new revision is reviewed.`;
    if (window.confirm(confirmation)) {
      automaticRepair.mutate();
    }
  };

  if (selectedPage) {
    return (
      <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 bg-white p-1.5 pr-4 rounded-full border shadow-sm">
            <Button variant="ghost" size="sm" onClick={() => setSelectedPageId(null)} className="rounded-full font-bold text-slate-600 hover:text-slate-900">
              <ArrowLeft className="mr-1.5 h-4 w-4" />Overview
            </Button>
            <div className="h-4 w-px bg-slate-300"></div>
            <h2 className="text-sm font-bold text-slate-800 truncate max-w-[200px] sm:max-w-[400px]">{job.title}</h2>
            <Badge variant="secondary" className="font-bold uppercase tracking-wider text-[10px] bg-slate-100 text-slate-600">Page {selectedPage.pageNumber}</Badge>
          </div>
          {job.machineAuditModel && (
            <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 shadow-none text-[10px] font-bold uppercase tracking-wider">
              Audited by {job.machineAuditModel}
            </Badge>
          )}
        </div>

        <PageInspector
          job={job}
          page={selectedPage}
          onBack={() => setSelectedPageId(null)}
          onPrev={prevPage ? () => setSelectedPageId(prevPage.id) : undefined}
          onNext={nextPage ? () => setSelectedPageId(nextPage.id) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back" className="font-bold text-slate-600 hover:text-slate-900 -ml-3"><ArrowLeft className="mr-1.5 h-4 w-4" />All drawing sets</Button>
        <span className="text-slate-300">/</span>
        <span className="truncate text-sm font-bold text-slate-900 tracking-tight">{job.title}</span>
      </div>

      <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-bold tracking-tight text-slate-900">{job.title}</h2>
                <StatusBadge status={job.status} />
                {job.machineAuditModel && (
                  <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 shadow-none text-[10px] font-bold uppercase tracking-wider">
                    Audited by {job.machineAuditModel}
                  </Badge>
                )}
              </div>
              <p className="mt-2 text-sm font-semibold text-slate-500 flex items-center gap-2">
                <span>{job.originalFilename}</span>
                <span className="text-slate-300">•</span>
                <span>{job.pageCount || "—"} pages</span>
                <span className="text-slate-300">•</span>
                <span>{languageLabels[job.sourceLanguage] || job.sourceLanguage} → {job.targetLanguage === 'ja' ? 'Japanese' : 'English'}</span>
                <span className="text-slate-300">•</span>
                <span>{job.drawingDepth === "everything" ? "Everything visible" : "Major text"}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {canDownloadOriginal && <a href={download("original")} download>
                <Button variant="outline" size="sm" className="font-semibold shadow-sm text-slate-600"><Download className="mr-1.5 h-3.5 w-3.5" />Original {job.sourceFormat === 'dxf' ? 'DXF' : 'PDF'}</Button>
              </a>}
              {job.sourceFormat === 'dxf' && (
                <>
                  {downloadAvailability?.ledger && <a href={download("ledger")} download>
                    <Button variant="outline" size="sm" className="font-semibold shadow-sm text-slate-600"><FileText className="mr-1.5 h-3.5 w-3.5" />Draft Ledger</Button>
                  </a>}
                  {downloadAvailability?.preservationReport && <a href={download("preservation-report")} download>
                    <Button variant="outline" size="sm" className="font-semibold shadow-sm text-slate-600"><FileArchive className="mr-1.5 h-3.5 w-3.5" />Preservation Report</Button>
                  </a>}
                  {downloadAvailability?.tableScript && reviewReady && (
                    <a href={download("table-script")} download>
                      <Button variant="outline" size="sm" className="font-semibold shadow-sm text-slate-600" data-testid="download-table-script"><Download className="mr-1.5 h-3.5 w-3.5" />AutoCAD Table Script</Button>
                    </a>
                  )}
                  {downloadAvailability?.draftDxf && job.status === "awaiting_review" && (
                    <a href={download("draft-dxf")} download>
                      <Button variant="outline" size="sm" data-testid="download-draft-dxf"><Download className="mr-1.5 h-3.5 w-3.5" />Draft machine-clean DXF</Button>
                    </a>
                  )}
                </>
              )}
              {(canDownloadSummary || canDownloadOutput) && (
                <>
                  {canDownloadSummary && <a href={download("summary")} download>
                    <Button variant="outline" size="sm" className="font-semibold shadow-sm text-slate-600"><FileText className="mr-1.5 h-3.5 w-3.5" />Summary Report</Button>
                  </a>}
                  {canDownloadOutput && <a href={download("download")} download>
                    <Button size="sm" className="bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] font-semibold shadow-sm text-white"><Download className="mr-1.5 h-3.5 w-3.5" />{job.sourceFormat === 'dxf' ? `Machine-clean ${job.targetLanguage === 'ja' ? 'Japanese' : 'English'} DXF (tables pending)` : `Final ${job.targetLanguage === 'ja' ? 'Japanese' : 'English'} PDF`}</Button>
                  </a>}
                </>
              )}
              {reviewReady && job.revisionCount > 0 && job.sourceFormat !== 'dxf' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restorePrevious.isPending}
                  onClick={() => {
                    if (window.confirm("Restore the immediately previous translated text as a new draft revision? The current revision and original PDF will remain unchanged in history, and the restored draft must pass audit and review again.")) {
                      restorePrevious.mutate();
                    }
                  }}
                  className="font-semibold shadow-sm text-slate-600"
                >
                  {restorePrevious.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Restore previous revision
                </Button>
              )}
              <Button variant="outline" size="sm" className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 font-semibold shadow-sm ml-auto" disabled={del.isPending} data-testid="button-delete-current-job" onClick={() => { const warning = working ? " Active processing will stop after its current operation." : ""; if (window.confirm(`Permanently delete "${job.title}" and all of its saved translations and private files?${warning}`)) del.mutate(); }}>
                {del.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}Delete job
              </Button>
            </div>
          </div>

          {working && (
            <div className="mt-8 rounded-xl bg-slate-50 p-5 border border-slate-100">
              <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">
                <span>{job.progressNote || "Preparing translation"}</span>
                <span className="text-[hsl(194_72%_35%)]">{job.progress || 0}%</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 border shadow-inner">
                <div className="h-full rounded-full bg-[hsl(194_72%_35%)] transition-all duration-500" style={{ width: `${job.progress || 0}%` }} />
              </div>
              <p className="mt-3 text-xs font-semibold text-slate-500">
                {job.sourceFormat === "dxf"
                  ? "Saved translations and evidence are retained while the targeted correction runs. Only affected text is sent for AI work, then the audit runs again; geometry is not altered and this is not a full restart."
                  : "Each completed page is saved. If processing is interrupted, it resumes from the first unfinished page."}
              </p>
            </div>
          )}

          {job.errorMessage && (
            <Alert variant="destructive" className="mt-6 shadow-sm">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="flex flex-wrap items-center justify-between gap-4 font-semibold">
                  <span>{job.errorMessage}</span>
                  {job.status === "failed" && (
                    <div className="flex flex-wrap justify-end gap-2">
                      {retryMetadata?.resumeAvailable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 border-emerald-300 bg-white text-xs text-emerald-800 hover:bg-emerald-50 shadow-sm"
                          onClick={() => retry.mutate("resume")}
                          disabled={retry.isPending}
                          data-testid="button-retry-resume"
                        >
                          {retry.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                          Resume saved work
                        </Button>
                      )}
                      {retryMetadata?.fullRestartAvailable && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 border-red-300 bg-white text-xs text-red-700 hover:bg-red-50 shadow-sm"
                          onClick={() => {
                            const warning = retryMetadata.fullRestartWarning
                              || "A full restart repeats AI translation and audit work and may use provider credits again.";
                            if (window.confirm(`${warning}\n\nContinue with a full restart?`)) {
                              retry.mutate("full_restart");
                            }
                          }}
                          disabled={retry.isPending}
                          data-testid="button-retry-restart"
                        >
                          {retry.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                          Full restart
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {job.status === "failed" && retryMetadata && (
                  <div className="mt-3 space-y-1 text-xs font-medium">
                    {retryMetadata.resumeAvailable ? (
                      <p className="text-emerald-800" data-testid="text-retry-resume-metadata">
                        {retryMetadata.resumeReason}. {retryMetadata.resumeValidationNote} Resume avoids repeating completed AI work; unfinished work is still subject to the normal audit and approval gates.
                      </p>
                    ) : (
                      <p className="text-red-800" data-testid="text-retry-resume-unavailable">
                        Resume unavailable: {retryMetadata.resumeReason}. {retryMetadata.resumeValidationNote} A full restart will repeat AI translation and audit usage.
                      </p>
                    )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {reviewReady && job.sourceFormat === "dxf" && (
        <Card className="border-blue-200 bg-blue-50/40 shadow-sm" data-testid="card-table-script-instructions">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-slate-900">Apply translated AutoCAD table text</CardTitle>
            <CardDescription className="text-xs font-medium text-slate-600">
              The machine-clean DXF is a partial translation: supported drawing text is translated, but ACAD_TABLE cells remain in the source language until this script is applied. The original and machine-clean DXFs remain unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm font-semibold leading-relaxed text-slate-700">
              <li>Download the draft machine-clean DXF and the AutoCAD table script. This is a review package, not an approved construction drawing.</li>
              <li>Verify the displayed source, table-script, and table-manifest SHA-256 values against the downloaded package.</li>
              <li>Open the DXF and immediately use SAVEAS to create a new derivative DWG. Never overwrite the original or machine-clean DXF.</li>
              <li>Use Windows AutoCAD 2021 or later with ActiveX support. For Unicode text, set LISPSYS to 1 or 2, restart AutoCAD, and record the verified value.</li>
              <li>Use APPLOAD to load the downloaded script.</li>
              <li>Run <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">CWORKS_APPLY_TABLE_TRANSLATIONS</code>.</li>
              <li>Copy the complete output from <code className="font-mono text-xs">CWORKS_APPLY_TABLE_TRANSLATIONS_BEGIN</code> through <code className="font-mono text-xs">CWORKS_APPLY_TABLE_TRANSLATIONS_END</code>, including every reported counter. Continue only when all expected cells applied and every failure counter is zero.</li>
              <li>If the command aborts or reports any missing, ambiguous, skipped, failed, unsafe, mismatched, or partial application, close without saving and discard that derivative. Preserve the reported counters in the review record, not the partial file.</li>
              <li>Run AUDIT.</li>
              <li>Inspect all layouts, dimensions, blocks, complex tables, and embedded content, then save the derivative as DWG. Close it, reopen the saved DWG, and inspect it again before submission. The app's machine-clean source remains a draft; script generation alone does not authorize release.</li>
            </ol>
          </CardContent>
        </Card>
      )}

      {reviewReady && (
        <Card className="border-slate-200 bg-white shadow-sm" data-testid="card-coverage-summary">
          <CardHeader className="pb-4 border-b border-slate-100 bg-slate-50/50">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-bold text-slate-900 tracking-tight">Translation Coverage</CardTitle>
                <CardDescription className="text-xs font-medium mt-1 max-w-3xl text-slate-500">
                  {job.sourceFormat === "dxf"
                    ? "Coverage includes translated ACAD_TABLE targets that remain pending in the separate reviewed script; the machine-clean DXF alone is not the completed table translation."
                    : "Coverage checkpoints reflect text recovery, translation, and safe placement onto the blueprint. Unresolved lines were not safely placed."}
                </CardDescription>
              </div>
              {coverage.complete ? (
                <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200 shadow-none font-bold uppercase tracking-wider text-[10px]"><CheckCircle2 className="w-3 h-3 mr-1" /> {job.sourceFormat === "dxf" ? "Translation evidence complete" : "Completeness verified"}</Badge>
              ) : (
                <Badge variant="destructive" className="bg-red-100 text-red-800 hover:bg-red-100 border-red-200 shadow-none font-bold uppercase tracking-wider text-[10px]"><AlertTriangle className="w-3 h-3 mr-1" /> Completeness failed</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Target", coverage.targetLineCount],
                ["Recovered", coverage.recoveredLineCount],
                ["Translated", coverage.translatedLineCount],
                ["Placed", coverage.placedLineCount],
                ["Unresolved", coverage.unresolvedLineCount],
                ["Placement", `${coverage.placementPercent}%`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-200 bg-white shadow-sm px-4 py-3.5 flex flex-col items-start justify-center">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">{label}</p>
                  <p className="text-2xl font-black text-slate-800 tracking-tight">{value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {reviewReady && !coverage.complete && (
        <Alert variant="destructive" data-testid="alert-coverage-incomplete" className="bg-red-50 border-red-200 text-red-900 shadow-sm">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertDescription className="font-medium text-sm leading-relaxed flex flex-wrap items-center justify-between gap-4 w-full">
            <span>{coverage.hybridPending
              ? <><span className="font-bold text-red-800">CAD derivative review required.</span> Table updates and any opaque or unmodeled drawing content must be verified in AutoCAD. The draft DXF is not text-complete; final approval/export stays locked. Download the draft and script above to continue in a separate DWG.</>
              : <><span className="font-bold text-red-800">Completeness check failed.</span> Only {coverage.placedLineCount} of {coverage.targetLineCount} target lines were safely placed ({coverage.placementPercent}%). Approval and final export are blocked.</>}</span>
            {canFixUnresolved ? (
              <Button
                onClick={startAutomaticRepair}
                disabled={automaticRepair.isPending}
                className="bg-red-700 hover:bg-red-800 text-white font-bold shadow-sm"
                data-testid="button-fix-unresolved-coverage"
              >
                {automaticRepair.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                {job.sourceFormat === "dxf" ? "Fix unresolved DXF text" : "Fix unresolved findings"}
              </Button>
            ) : (
              <span className="text-red-700 text-xs font-bold uppercase tracking-wider bg-red-100 px-3 py-1.5 rounded-md border border-red-200">{coverage.hybridPending ? "Complete CAD review on a separate DWG" : "DXF requires new translation pass"}</span>
            )}
            {automaticRepair.isPending && job.sourceFormat === "dxf" && (
              <span className="w-full text-xs font-semibold text-red-800" role="status" data-testid="text-native-dxf-repair-progress">
                Targeted DXF correction is starting from saved translations and evidence. Affected text will receive AI work and the audit will run again; geometry remains unchanged.
              </span>
            )}
            {automaticRepair.isError && (
              <span className="w-full text-xs font-semibold text-red-800" role="alert" data-testid="text-repair-error">
                {automaticRepair.error instanceof Error ? automaticRepair.error.message : "The repair request could not be started. No new revision was created."}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {reviewReady && job.sourceFormat === "dxf" && canFixUnresolved && coverage.complete && (
        <Alert className="border-violet-200 bg-violet-50 text-violet-950 shadow-sm" data-testid="alert-native-dxf-targeted-repair">
          <Wrench className="h-4 w-4 text-violet-700" />
          <AlertDescription className="text-sm font-medium leading-relaxed">
            <span className="font-bold">Targeted native DXF correction is available for the remaining audit finding{unresolvedFindingCount === 1 ? "" : "s"}.</span>{" "}
            It uses saved translations and review evidence, incurs AI work only for affected text, and runs a complete audit again. Geometry is not altered and this is not a full translation restart. Text fit is not guaranteed; review remains required.
            {automaticRepair.isPending && (
              <span className="mt-2 block text-xs font-bold" role="status" data-testid="text-native-dxf-repair-progress">
                Targeted DXF correction is in progress from saved translations and evidence.
              </span>
            )}
            {automaticRepair.isError && (
              <span className="mt-2 block text-xs font-bold text-red-800" role="alert" data-testid="text-repair-error">
                {automaticRepair.error instanceof Error ? automaticRepair.error.message : "The targeted correction could not be started. No new revision was created."}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {job.feedbackNotes && reviewHistory.length === 0 && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900 shadow-sm">
          <MessageSquare className="h-4 w-4" />
          <AlertDescription className="font-medium"><span className="font-bold">Latest revision notes: </span>{job.feedbackNotes}</AlertDescription>
        </Alert>
      )}

      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <CardTitle className="text-base font-bold text-slate-900 tracking-tight">{job.sourceFormat === 'dxf' ? 'Document Drawings' : 'Document Pages'}</CardTitle>
            <CardDescription className="font-medium text-sm mt-1 text-slate-500">
              {reviewReady ? `Inspect each ${job.sourceFormat === 'dxf' ? 'drawing' : 'page'} side-by-side. Verify AI findings before final sign-off.` : `${job.pagesDone || 0} of ${job.pageCount || "—"} ${job.sourceFormat === 'dxf' ? 'drawings' : 'pages'} translated · thumbnails render upon completion`}
            </CardDescription>
          </div>
          {reviewReady && (
            <div className="flex items-center gap-4">
              {canFixUnresolved && (
                <Button
                  onClick={startAutomaticRepair}
                  disabled={automaticRepair.isPending}
                  className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold shadow-sm"
                  data-testid="button-fix-unresolved-pages"
                >
                  {automaticRepair.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
                  {job.sourceFormat === "dxf" ? "Fix unresolved DXF text" : "Fix unresolved findings"}
                </Button>
              )}
              <div className="text-right">
              <div className="text-xl font-black text-[hsl(194_72%_35%)] tracking-tight">
                {pages.filter(p => p.review?.checked).length} <span className="text-slate-400 font-bold">/ {pages.length}</span>
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-0.5">{job.sourceFormat === 'dxf' ? 'Drawings' : 'Pages'} Verified</div>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-5 bg-slate-50/30">
          {reviewReady ? (
            <PageGrid job={job} pages={pages} onSelect={setSelectedPageId} />
          ) : (
            <div className="py-12 text-center text-sm font-semibold text-slate-400">
              Thumbnails and findings will appear here after the translation pass completes.
            </div>
          )}
        </CardContent>
      </Card>

      {reviewReady && !(job.sourceFormat === "dxf" && coverage.hybridPending) && <SignOffPanel job={job} coverage={coverage} pages={pages} onDecision={feedback.mutate} busy={feedback.isPending} />}
      {reviewReady && job.sourceFormat === "dxf" && coverage.hybridPending && cadDerivativeDraft && (
        <HybridCadDerivativeWorkflow
          job={job}
          binding={cadDerivativeDraft}
          derivatives={derivatives}
          reviewHistory={reviewHistory}
          submissionOpen={job.status === "awaiting_review" && cadDerivativeDraft.submissionAllowed}
        />
      )}
      {reviewReady && job.sourceFormat === "dxf" && coverage.hybridPending && !cadDerivativeDraft && cadDerivativeRequirementsLoading && (
        <Card><CardContent className="flex items-center justify-center gap-2 py-8 text-sm font-semibold text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading source-bound derivative requirements</CardContent></Card>
      )}
      {reviewReady && job.sourceFormat === "dxf" && coverage.hybridPending && !cadDerivativeDraft && !cadDerivativeRequirementsLoading && (
        <Alert variant="destructive" data-testid="alert-derivative-binding-unavailable">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="font-medium">{cadDerivativeRequirementsError instanceof Error ? cadDerivativeRequirementsError.message : "The server has not supplied an upload binding for this draft revision. Do not upload an unbound CAD file; refresh after the source, table script, and manifest evidence are available."}</AlertDescription>
        </Alert>
      )}
      {canDownloadFinal && job.sourceFormat === "dxf" && (
        <HumanAdjustedDerivatives
          job={job}
          derivatives={derivatives}
          sourceSha256={reviewHistory.find(history => history.decision === "approve" && history.revisionCount === job.approvedRevision)?.translatedOutputSha256}
        />
      )}
      {reviewHistory.length > 0 && <ReviewHistoryTrail history={reviewHistory} isDxf={job.sourceFormat === "dxf"} />}
    </div>
  );
}
