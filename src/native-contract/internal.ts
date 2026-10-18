import type { ValidateFunction } from 'ajv';
import type { CapabilityView, CheckedControl, CheckedRequest, CheckedResponse, CheckedStream,
  CompiledContract, DispatchCandidate, DispatchPermit, JsonObject, Limits, MethodDescriptor,
  RawRequestCandidate, SafetyClassification } from './types.js';

export const UHP = 'https://luvus.dev/protocol/uhp/v1/';
export const SCOPES = new Set(['read', 'workspace', 'agent', 'terminal', 'orchestration', 'extensions', 'admin']);
export const STREAM_METHODS = new Set(['events.subscribe', 'terminal.backend.events.subscribe', 'terminal.backend.observe', 'terminal.backend.control']);
export type ContractData = {
  bundle: JsonObject; documents: Record<string, unknown>; limits: Limits;
  validators: Map<string, ValidateFunction>; requestMethods: readonly string[];
  branches: Map<string, readonly string[]>;
};
export type ViewData = { contract: CompiledContract; capabilities: JsonObject; methods: Map<string, MethodDescriptor> };
export type CandidateData = { view: CapabilityView; descriptor: MethodDescriptor; stream?: CheckedStream };
export type PermitData = { candidate: DispatchCandidate; principal: string; classification: SafetyClassification;
  supportedActions: readonly string[]; };
export type StreamData = { permit: DispatchPermit; identity: JsonObject | null };
// WeakMap 同时防止伪造 handle 和响应/许可跨 validator 实例使用。
export const contracts = new WeakMap<CompiledContract, ContractData>();
export const views = new WeakMap<CapabilityView, ViewData>();
export const candidates = new WeakMap<CheckedRequest | RawRequestCandidate | CheckedControl, CandidateData>();
export const permits = new WeakMap<DispatchPermit, PermitData>();
export const responses = new WeakMap<CheckedResponse, { candidate: DispatchCandidate | null; contract: CompiledContract }>();
export const streams = new WeakMap<CheckedStream, StreamData>();
