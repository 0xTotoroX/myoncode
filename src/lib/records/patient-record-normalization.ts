/**
 * [INPUT]: 依赖 @/types/patient 的病历领域类型；输入为待归一化记录、既有可信记录与原始文字。
 * [OUTPUT]: normalizePatientRecord、mergePatientRecord、applySourceTextBasicInfo；统一字段、日期与读数，清除模型身份并保留既有身份，补全原文人口学信息。
 * [POS]: records/ 的病历纯数据转换；不调用模型、认证或存储，由 extraction.ts 编排调用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { BasicInfo, LabResult, LabResultCategory, LabResultSource, PatientRecord, TreatmentLine } from '@/types/patient'

const DATE_PATTERN = /^\d{4}-(\d{2})(-\d{2})?$/
const LAB_CATEGORIES = new Set<LabResultCategory>(['blood-routine', 'blood-biochemistry', 'tumor-marker'])
const LAB_SOURCES = new Set<LabResultSource>(['ocr', 'manual', 'test', 'derived'])

type NormalizePatientRecordOptions = {
  preserveId?: boolean
}

function normalizeNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const normalized = Number(value.trim())
    return Number.isFinite(normalized) ? normalized : undefined
  }

  return undefined
}

function normalizeDate(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const parts = value
    .trim()
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/-+$/g, '')
    .split('-')
    .filter(Boolean)

  if (parts.length !== 2 && parts.length !== 3) {
    return undefined
  }

  const [year, month, day] = parts

  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || (day !== undefined && !/^\d{1,2}$/.test(day))) {
    return undefined
  }

  const monthNumber = Number(month)
  const dayNumber = day === undefined ? undefined : Number(day)

  if (monthNumber < 1 || monthNumber > 12 || (dayNumber !== undefined && (dayNumber < 1 || dayNumber > 31))) {
    return undefined
  }

  const normalized = `${year}-${month.padStart(2, '0')}${day === undefined ? '' : `-${day.padStart(2, '0')}`}`
  return DATE_PATTERN.test(normalized) ? normalized : undefined
}

function normalizeTreatmentLine(line: Partial<TreatmentLine> | undefined, fallbackLineNumber: number, preserveId: boolean): TreatmentLine {
  return {
    id: preserveId ? normalizeString(line?.id) : undefined,
    lineNumber: normalizeNumber(line?.lineNumber) ?? fallbackLineNumber,
    startDate: normalizeDate(line?.startDate),
    endDate: normalizeDate(line?.endDate),
    regimen: normalizeString(line?.regimen),
    biopsy: normalizeString(line?.biopsy),
    immunohistochemistry: normalizeString(line?.immunohistochemistry),
    geneticTest: normalizeString(line?.geneticTest),
  }
}

function normalizeString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberFromMatch(match: RegExpMatchArray | null) {
  return normalizeNumber(match?.[1])
}

function inRange(value: number | undefined, min: number, max: number) {
  return value !== undefined && value >= min && value <= max ? value : undefined
}

function extractDemographicName(input: string) {
  const explicit = input.match(/(?:患者姓名|病人姓名|姓名)[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{2,12})/)

  if (explicit?.[1]) {
    return explicit[1].trim()
  }

  for (const line of input.split(/\n+/).map((item) => item.trim())) {
    if (!/\d{1,3}\s*岁/.test(line) || !/(^|[，,、\s])(男|女)(?=$|[，,。；;\s])/.test(line)) {
      continue
    }

    const inferred = line.match(/^([\u4e00-\u9fa5A-Za-z·]{2,12})[，,、\s]+(?:\d{1,3}\s*岁|男|女)/)
    if (inferred?.[1]) {
      return inferred[1].trim()
    }
  }

  return undefined
}

function extractBasicInfoFromText(input: string): Partial<BasicInfo> | undefined {
  const age = inRange(numberFromMatch(input.match(/(?:年龄[:：]?\s*)?(\d{1,3})\s*岁/)), 0, 130)
  const height = inRange(
    numberFromMatch(input.match(/身高[:：]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:厘米|cm)?/i)) ??
      numberFromMatch(input.match(/(\d{2,3}(?:\.\d+)?)\s*(?:厘米|cm)/i)),
    40,
    260,
  )
  const weight = inRange(
    numberFromMatch(input.match(/体重[:：]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:千克|公斤|kg)?/i)) ??
      numberFromMatch(input.match(/(\d{2,3}(?:\.\d+)?)\s*(?:千克|公斤|kg)/i)),
    1,
    300,
  )
  const gender = input.match(/(?:^|[，,。；;\s])(男|女)(?=$|[，,。；;\s])/)?.[1]
  const basicInfo: Partial<BasicInfo> = {
    age,
    gender,
    height,
    name: extractDemographicName(input),
    weight,
  }
  const entries = Object.entries(basicInfo).filter(([, value]) => value !== undefined)

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function applySourceTextBasicInfo(record: PatientRecord, input: string): PatientRecord {
  const basicInfo = extractBasicInfoFromText(input)

  if (!basicInfo) {
    return record
  }

  return normalizePatientRecord({
    ...record,
    basicInfo: mergeDefinedFields(record.basicInfo, basicInfo),
  })
}

function normalizeLabCategory(value: unknown): LabResultCategory | undefined {
  return typeof value === 'string' && LAB_CATEGORIES.has(value as LabResultCategory) ? (value as LabResultCategory) : undefined
}

function normalizeLabSource(value: unknown): LabResultSource | undefined {
  return typeof value === 'string' && LAB_SOURCES.has(value as LabResultSource) ? (value as LabResultSource) : undefined
}

function normalizeLabResult(reading: Partial<LabResult> | undefined, preserveId: boolean): LabResult | null {
  const category = normalizeLabCategory(reading?.category)
  const itemCode = normalizeString(reading?.itemCode)
  const itemName = normalizeString(reading?.itemName)
  const value = normalizeNumber(reading?.value)

  if (!category || !itemCode || !itemName || value === undefined) {
    return null
  }

  return {
    id: preserveId ? normalizeString(reading?.id) : undefined,
    batchId: preserveId ? normalizeString(reading?.batchId) : undefined,
    category,
    derivationMethod: normalizeString(reading?.derivationMethod),
    isDerived: reading?.isDerived === true,
    itemCode,
    itemName,
    referenceHigh: normalizeNumber(reading?.referenceHigh),
    referenceLow: normalizeNumber(reading?.referenceLow),
    source: normalizeLabSource(reading?.source),
    testDate: normalizeDate(reading?.testDate),
    unit: normalizeString(reading?.unit),
    value,
  }
}

export function normalizePatientRecord(input: Partial<PatientRecord>, options: NormalizePatientRecordOptions = {}): PatientRecord {
  const preserveId = options.preserveId ?? true
  const treatmentLines = Array.isArray(input.treatmentLines)
    ? input.treatmentLines.map((line, index) => normalizeTreatmentLine(line, index + 1, preserveId))
    : []
  const labResults = Array.isArray(input.labResults)
    ? input.labResults.map((reading) => normalizeLabResult(reading, preserveId)).filter((reading): reading is LabResult => reading !== null)
    : undefined

  return {
    id: preserveId ? normalizeString(input.id) : undefined,
    followUpStatus: preserveId ? input.followUpStatus : undefined,
    basicInfo: input.basicInfo
      ? {
          name: normalizeString(input.basicInfo.name),
          gender: normalizeString(input.basicInfo.gender),
          age: normalizeNumber(input.basicInfo.age),
          height: normalizeNumber(input.basicInfo.height),
          weight: normalizeNumber(input.basicInfo.weight),
          tumorType: normalizeString(input.basicInfo.tumorType),
          diagnosisDate: normalizeDate(input.basicInfo.diagnosisDate),
          stage: normalizeString(input.basicInfo.stage),
        }
      : undefined,
    clinicalNotes: normalizeString(input.clinicalNotes),
    initialOnset: input.initialOnset
      ? {
          triggerDate: normalizeDate(input.initialOnset.triggerDate),
          treatment: normalizeString(input.initialOnset.treatment),
          immunohistochemistry: normalizeString(input.initialOnset.immunohistochemistry),
          geneticTest: normalizeString(input.initialOnset.geneticTest),
        }
      : undefined,
    labResults: labResults && labResults.length > 0 ? labResults : undefined,
    treatmentLines: treatmentLines.sort((a, b) => a.lineNumber - b.lineNumber),
  }
}

function mergeTreatmentLines(current: TreatmentLine[], incoming: TreatmentLine[]) {
  const byLineNumber = new Map<number, TreatmentLine>()

  for (const line of current) {
    byLineNumber.set(line.lineNumber, line)
  }

  for (const line of incoming) {
    const existing = byLineNumber.get(line.lineNumber)

    byLineNumber.set(line.lineNumber, {
      ...existing,
      ...line,
      id: existing?.id,
      lineNumber: line.lineNumber,
      regimen: line.regimen ?? existing?.regimen,
      biopsy: line.biopsy ?? existing?.biopsy,
      immunohistochemistry: line.immunohistochemistry ?? existing?.immunohistochemistry,
      geneticTest: line.geneticTest ?? existing?.geneticTest,
      startDate: line.startDate ?? existing?.startDate,
      endDate: line.endDate ?? existing?.endDate,
    })
  }

  return [...byLineNumber.values()].sort((a, b) => a.lineNumber - b.lineNumber)
}

function mergeLabResults(current: LabResult[] | undefined, incoming: LabResult[] | undefined) {
  if (!incoming?.length) return current
  const merged = [...(current ?? [])]
  for (const reading of incoming) {
    const repeated = reading.testDate && merged.some((existing) =>
      existing.testDate === reading.testDate && existing.category === reading.category &&
      existing.itemCode === reading.itemCode && existing.value === reading.value && existing.unit === reading.unit)
    if (!repeated) merged.push(reading)
  }
  return merged
}

function mergeDefinedFields<T extends object>(current: T | undefined, incoming: T | undefined): T | undefined {
  const next = { ...(current ?? {}) } as Record<string, unknown>

  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }

  return Object.keys(next).length > 0 ? (next as T) : undefined
}

export function mergePatientRecord(current: PatientRecord, incoming: Partial<PatientRecord>) {
  const normalizedIncoming = normalizePatientRecord(incoming, { preserveId: false })

  return normalizePatientRecord({
    ...current,
    basicInfo: mergeDefinedFields(current.basicInfo, normalizedIncoming.basicInfo),
    clinicalNotes: normalizedIncoming.clinicalNotes ?? current.clinicalNotes,
    initialOnset: mergeDefinedFields(current.initialOnset, normalizedIncoming.initialOnset),
    labResults: mergeLabResults(current.labResults, normalizedIncoming.labResults),
    treatmentLines: mergeTreatmentLines(current.treatmentLines, normalizedIncoming.treatmentLines),
  })
}
