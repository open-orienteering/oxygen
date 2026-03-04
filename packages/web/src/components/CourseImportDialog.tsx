import { useState, useCallback, useRef } from "react";
import { trpc } from "../lib/trpc";
import { SearchableSelect } from "./SearchableSelect";

interface Props {
  onClose: () => void;
  onSuccess: () => void;
}

type PreviewData = NonNullable<
  Awaited<ReturnType<ReturnType<typeof trpc.course.previewImport.useMutation>["mutateAsync"]>>
>;

export function CourseImportDialog({ onClose, onSuccess }: Props) {
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [fileType, setFileType] = useState<"xml" | "ocd">("xml");
  const [fileData, setFileData] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [classMapping, setClassMapping] = useState<Record<string, number[]>>({});
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewMutation = trpc.course.previewImport.useMutation({
    onSuccess: (data) => {
      setPreview(data);
      // Build initial class mapping from auto-matches
      const mapping: Record<string, number[]> = {};
      for (const course of data.courses) {
        const matched = course.classMatches
          .filter((m) => m.matched)
          .map((m) => m.dbClassId);
        if (matched.length > 0) {
          mapping[course.name] = matched;
        }
      }
      setClassMapping(mapping);
      setStep("preview");
    },
  });

  const importMutation = trpc.course.importCourses.useMutation({
    onSuccess: () => {
      setStep("result");
    },
  });

  const handleFile = useCallback((file: File) => {
    const isXml = file.name.toLowerCase().endsWith(".xml");
    const isOcd = file.name.toLowerCase().endsWith(".ocd");
    if (!isXml && !isOcd) return;

    setFileName(file.name);
    const type = isXml ? "xml" : "ocd";
    setFileType(type);

    const reader = new FileReader();
    reader.onload = (e) => {
      if (type === "xml") {
        const content = e.target?.result as string;
        setFileData(content);
        previewMutation.mutate({ xmlContent: content });
      } else {
        const buf = e.target?.result as ArrayBuffer;
        // Fast ArrayBuffer to Base64 (safe for small-to-medium files like OCD)
        let binary = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = window.btoa(binary);
        setFileData(base64);
        previewMutation.mutate({ ocdBase64: base64 });
      }
    };

    if (type === "xml") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }, [previewMutation]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleImport = () => {
    importMutation.mutate({
      ...(fileType === "xml" ? { xmlContent: fileData } : { ocdBase64: fileData }),
      classMapping,
    });
  };

  const updateClassMapping = (courseName: string, classIds: number[]) => {
    setClassMapping((prev) => ({
      ...prev,
      [courseName]: classIds.filter((id) => id > 0),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Import Courses (IOF XML or OCAD OCD)
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* ── Upload Step ─────────────────────────────────── */}
          {step === "upload" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50"
                }`}
            >
              <svg className="mx-auto w-12 h-12 text-slate-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm text-slate-600 mb-2">
                Drop an IOF 3.0 CourseData XML or OCAD 12 OCD file here, or
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
              >
                Browse files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xml,.ocd"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <p className="text-xs text-slate-400 mt-3">
                Exported from OCAD, Purple Pen, Condes, or similar
              </p>

              {previewMutation.isPending && (
                <div className="mt-6 flex items-center justify-center gap-2 text-sm text-blue-600">
                  <div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
                  Parsing {fileName}...
                </div>
              )}

              {previewMutation.isError && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {previewMutation.error.message}
                </div>
              )}
            </div>
          )}

          {/* ── Preview Step ────────────────────────────────── */}
          {step === "preview" && preview && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-4 gap-3">
                <SummaryBox label="Courses" value={preview.courses.length} />
                <SummaryBox label="Controls" value={preview.totalControls} />
                <SummaryBox label="New controls" value={preview.newControls} color="emerald" />
                <SummaryBox label="Existing" value={preview.existingControls} color="blue" />
              </div>

              {/* Course table with class mapping */}
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">
                  Courses and Class Assignments
                </h3>
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">Course</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">Length</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">Controls</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">XML Class</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">DB Class</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.courses.map((course) => {
                        const assignments = course.xmlClassNames;
                        const hasMultiple = assignments.length > 1;

                        return assignments.length === 0 ? (
                          <tr key={course.name}>
                            <td className="px-3 py-2 font-medium text-slate-900">{course.name}</td>
                            <td className="px-3 py-2 text-slate-600">{(course.length / 1000).toFixed(1)} km</td>
                            <td className="px-3 py-2 text-slate-600">{course.controlCount}</td>
                            <td className="px-3 py-2 text-slate-400 italic">None</td>
                            <td className="px-3 py-2 text-slate-400">—</td>
                          </tr>
                        ) : (
                          assignments.map((xmlClass, i) => {
                            const matchInfo = course.classMatches[i];
                            const currentMapping = classMapping[course.name] ?? [];
                            return (
                              <tr key={`${course.name}-${xmlClass}`}>
                                {i === 0 && (
                                  <>
                                    <td className="px-3 py-2 font-medium text-slate-900" rowSpan={hasMultiple ? assignments.length : undefined}>
                                      {course.name}
                                    </td>
                                    <td className="px-3 py-2 text-slate-600" rowSpan={hasMultiple ? assignments.length : undefined}>
                                      {(course.length / 1000).toFixed(1)} km
                                    </td>
                                    <td className="px-3 py-2 text-slate-600" rowSpan={hasMultiple ? assignments.length : undefined}>
                                      {course.controlCount}
                                    </td>
                                  </>
                                )}
                                <td className="px-3 py-2 text-slate-700">{xmlClass}</td>
                                <td className="px-3 py-2">
                                  <SearchableSelect
                                    value={matchInfo?.matched ? matchInfo.dbClassId : (currentMapping[i] ?? 0)}
                                    onChange={(v) => {
                                      const newMapping = [...currentMapping];
                                      newMapping[i] = Number(v);
                                      updateClassMapping(course.name, newMapping);
                                    }}
                                    placeholder="Select class..."
                                    searchPlaceholder="Search..."
                                    options={[
                                      { value: 0, label: "— Skip —" },
                                      ...preview.dbClasses.map((c) => ({
                                        value: c.id,
                                        label: c.name,
                                      })),
                                    ]}
                                  />
                                </td>
                              </tr>
                            );
                          })
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => { setStep("upload"); setPreview(null); }}
                  className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  Back
                </button>
                <button
                  onClick={handleImport}
                  disabled={importMutation.isPending}
                  className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {importMutation.isPending ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      Import {preview.courses.length} courses
                    </>
                  )}
                </button>
              </div>

              {importMutation.isError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {importMutation.error.message}
                </div>
              )}
            </div>
          )}

          {/* ── Result Step ─────────────────────────────────── */}
          {step === "result" && importMutation.data && (
            <div className="space-y-4">
              <div className="p-6 bg-emerald-50 border border-emerald-200 rounded-xl text-center">
                <svg className="mx-auto w-12 h-12 text-emerald-600 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <h3 className="text-lg font-semibold text-emerald-900 mb-2">Import Complete</h3>
                <div className="text-sm text-emerald-700 space-y-1">
                  <p>{importMutation.data.coursesCreated} courses created, {importMutation.data.coursesUpdated} updated</p>
                  <p>{importMutation.data.controlsCreated} controls created, {importMutation.data.controlsUpdated} updated</p>
                  {importMutation.data.classesAssigned > 0 && (
                    <p>{importMutation.data.classesAssigned} class assignments made</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => { onSuccess(); onClose(); }}
                className="w-full px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryBox({ label, value, color = "slate" }: { label: string; value: number; color?: string }) {
  const colorClasses =
    color === "emerald"
      ? "bg-emerald-50 border-emerald-200 text-emerald-700"
      : color === "blue"
        ? "bg-blue-50 border-blue-200 text-blue-700"
        : "bg-slate-50 border-slate-200 text-slate-700";
  return (
    <div className={`${colorClasses} border rounded-lg p-3 text-center`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}
