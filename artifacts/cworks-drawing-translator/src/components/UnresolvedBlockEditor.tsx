import React, { useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  CheckCircle2, 
  Eye,
  Info,
  Loader2,
  Save,
  Type,
  X,
  XCircle
} from "lucide-react";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type UnresolvedBlockEditorProps = {
  sourceText: string;
  currentTranslation: string;
  rejectionReason: string;
  targetLanguage?: 'en' | 'ja';
  isBusy?: boolean;
  isReadOnly?: boolean;
  onPreview: (text: string, reason: string) => Promise<{
    success: boolean;
    message?: string;
    previewId?: string;
    thumbnailUrl?: string;
  }>;
  onDiscard: (previewId?: string) => void | Promise<void>;
  onCommit: (previewId: string) => void;
  className?: string;
};

export function UnresolvedBlockEditor({
  sourceText,
  currentTranslation,
  rejectionReason,
  targetLanguage = 'en',
  isBusy = false,
  isReadOnly = false,
  onPreview,
  onDiscard,
  onCommit,
  className
}: UnresolvedBlockEditorProps) {
  const [editedText, setEditedText] = useState(currentTranslation);
  const [reason, setReason] = useState("");
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'success' | 'failure'>('idle');
  const [previewMessage, setPreviewMessage] = useState<string>('');
  const [previewId, setPreviewId] = useState<string>();
  const [thumbnailUrl, setThumbnailUrl] = useState<string>();

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditedText(e.target.value);
    if (previewState !== 'idle') {
      setPreviewState('idle');
      setPreviewMessage('');
      setPreviewId(undefined);
      setThumbnailUrl(undefined);
    }
  };

  const handlePreview = async () => {
    if (!editedText.trim() || reason.trim().length < 3 || isBusy || isReadOnly) return;
    setPreviewState('loading');
    setPreviewMessage('');
    try {
      const result = await onPreview(editedText, reason);
      if (result.success && result.previewId) {
        setPreviewState('success');
        setPreviewMessage(result.message || 'Text conforms to spatial constraints.');
        setPreviewId(result.previewId);
        setThumbnailUrl(result.thumbnailUrl);
      } else {
        setPreviewState('failure');
        setPreviewMessage(result.message || 'Text exceeds bounding box. Further abbreviation required.');
      }
    } catch (err) {
      setPreviewState('failure');
      setPreviewMessage('Preview failed to process.');
    }
  };

  const handleCommit = () => {
    if (!previewId || previewState !== "success" || isBusy || isReadOnly) return;
    onCommit(previewId);
  };

  const handleDiscard = async () => {
    if (isBusy || isReadOnly) return;
    const discardedPreviewId = previewId;
    setPreviewState("idle");
    setPreviewMessage("");
    setPreviewId(undefined);
    setThumbnailUrl(undefined);
    try {
      await onDiscard(discardedPreviewId);
    } catch {
      setPreviewState("failure");
      setPreviewMessage("The preview could not be discarded. Try again.");
    }
  };

  return (
    <div className={cn("flex flex-col rounded-md border border-slate-200 bg-white shadow-sm font-sans text-sm", className)}>
      <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex flex-col gap-3 rounded-t-md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2 text-slate-800 font-semibold">
            <Type className="w-4 h-4 text-[hsl(194_72%_35%)]" />
            <span>Manual Text Touch-up</span>
          </div>
          <Badge variant="secondary" className="bg-slate-200/60 text-slate-600 border-slate-300 font-medium shadow-none px-2 py-0.5 text-[10px] tracking-wide uppercase">
            {rejectionReason}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-1">
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Source Text</span>
            <div className="px-3 py-2 bg-white border border-slate-200 rounded text-slate-700 font-mono text-xs break-words shadow-sm min-h-[44px]">
              {sourceText}
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Rejected Translation</span>
            <div className="px-3 py-2 bg-slate-100 border border-slate-200 rounded text-slate-500 font-mono text-xs break-words line-through decoration-slate-400/60 min-h-[44px]">
              {currentTranslation}
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">
        <div className="space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-700 flex items-center justify-between">
            <span>Shorter {targetLanguage === 'ja' ? 'Japanese' : 'English'} Translation</span>
            <span className="text-slate-400 font-medium normal-case tracking-normal">
              {editedText.length} chars
            </span>
          </label>
          <Textarea 
            value={editedText}
            onChange={handleTextChange}
            disabled={isBusy || isReadOnly}
            className="font-mono text-sm resize-none h-20 shadow-inner focus-visible:ring-[hsl(194_72%_35%)] bg-slate-50/50"
            placeholder="Enter abbreviated translation..."
          />
        </div>

        <div className="space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-700">
            Neutral change reason
          </label>
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setPreviewState("idle");
              setPreviewId(undefined);
              setThumbnailUrl(undefined);
            }}
            disabled={isBusy || isReadOnly}
            className="resize-none h-16 text-sm shadow-inner bg-slate-50/50"
            placeholder="Example: Shorten the room heading to fit the existing bounded region."
          />
        </div>

        {thumbnailUrl && previewState === "success" && (
          <div className="overflow-hidden rounded border border-emerald-200 bg-slate-50">
            <div className="border-b border-emerald-100 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              Renderer preview
            </div>
            <img src={thumbnailUrl} alt="Manual touch-up renderer preview" className="max-h-72 w-full object-contain" />
          </div>
        )}

        <div className={cn(
          "px-3 py-2.5 rounded border text-xs flex items-start gap-2 transition-colors",
          previewState === 'idle' && "bg-slate-50 border-slate-200 text-slate-600",
          previewState === 'loading' && "bg-sky-50 border-sky-200 text-sky-700",
          previewState === 'success' && "bg-emerald-50 border-emerald-200 text-emerald-700",
          previewState === 'failure' && "bg-amber-50 border-amber-200 text-amber-800"
        )}>
          {previewState === 'idle' && <Info className="w-4 h-4 mt-0.5 opacity-70 shrink-0" />}
          {previewState === 'loading' && <Loader2 className="w-4 h-4 mt-0.5 animate-spin shrink-0" />}
          {previewState === 'success' && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          {previewState === 'failure' && <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          
          <div className="flex-1 font-medium leading-relaxed mt-0.5">
            {previewState === 'idle' && "Preview to ensure the new text fits within the drawing's spatial constraints."}
            {previewState === 'loading' && "Testing bounding box capacity..."}
            {previewState === 'success' && previewMessage}
            {previewState === 'failure' && previewMessage}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2 mt-1">
          <Button 
            variant="ghost" 
            size="sm"
            onClick={() => void handleDiscard()}
            disabled={isBusy || isReadOnly}
            className="text-slate-500 hover:text-slate-800 font-semibold"
          >
            <X className="w-4 h-4 mr-1.5" />
            Discard
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            onClick={handlePreview}
            disabled={isBusy || isReadOnly || !editedText.trim() || reason.trim().length < 3}
            className="shadow-sm font-semibold border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            <Eye className="w-4 h-4 mr-1.5 text-slate-400" />
            Preview Fit
          </Button>
          <Button 
            size="sm"
            onClick={handleCommit}
            disabled={isBusy || isReadOnly || previewState !== 'success' || !previewId}
            className="bg-[hsl(194_72%_35%)] hover:bg-[hsl(194_72%_29%)] text-white shadow-sm font-semibold"
          >
            {isBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
            Commit Translation
          </Button>
        </div>
      </div>
    </div>
  );
}
