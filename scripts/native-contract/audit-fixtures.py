# 离线审计固定原生 fixture、方法映射和测试矩阵草案，不执行验证器或启动原生实例。
"""审计原生契约 fixture、映射与矩阵；不执行 validator，不启动原生实例，不代表 Bun 门禁。"""

import argparse
import copy
import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urldefrag, urljoin


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "test/fixtures/luvus/0.14.3/linux"
MAPPINGS = ROOT / "test/fixtures/native-contract"
MATRIX = ROOT / "test/fixtures/native-contract/matrix.json"
BASE = "9c4a7fe34fc3efa461d96a502860e61b05817c44"
SCHEMA_SHA = "00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6"
STREAMS = {"events.subscribe", "terminal.backend.events.subscribe",
           "terminal.backend.observe", "terminal.backend.control"}
COLUMNS = ["method", "profile", "transport", "params_evidence", "request_branches",
           "native_scope_hint", "native_access_hint", "native_idempotent_hint",
           "boundary_hint", "trusted_safety", "runtime_enabled"]


# 条件不满足时抛出资料完整性错误，确保优化模式也不会跳过检查。
def check(condition, message):
    # 优化模式也必须执行资料完整性检查。
    if not condition:
        raise ValueError(message)


# 以 UTF-8 读取并解析指定 JSON 资料。
def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


# 返回文件原始字节的 SHA-256 摘要，供固定证据完整性比对。
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# 按 JSON Pointer 路径遍历对象或数组，返回选中的资料片段。
def pointer(value, path):
    check(path == "" or path.startswith("/"), f"非法 JSON Pointer: {path}")
    for token in path.split("/")[1:]:
        key = token.replace("~1", "/").replace("~0", "~")
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


# 仅返回版本化原生 fixture 内存在的非符号链接文件，拒绝目录外路径。
def fixture_file(relative):
    # 只读版本化原生 fixture，不接受目录外的文件或 URL。
    path = ROOT / relative
    check(path.is_relative_to(FIXTURE), f"非 fixture 路径: {relative}")
    check(not path.is_symlink() and path.resolve().is_relative_to(FIXTURE.resolve()),
          f"非普通 fixture 路径: {relative}")
    check(path.is_file(), f"缺少 fixture: {relative}")
    return path


# 合并 schema 与实时能力资料，生成包含路由、参数证据和未启用标记的方法映射。
def method_rows(bundle, session, host):
    methods = bundle["request"]["properties"]["method"]["enum"]
    check(len(methods) == len(set(methods)) == 223, "原文方法枚举改变")
    profiles = {}
    hints = {}
    for name, caps in [("session", session), ("host", host)]:
        check(len(caps["methods"]) == len(set(caps["methods"])), "实时方法重复")
        check(len(caps["method_contracts"]) == len(caps["methods"]), "分类记录数不符")
        for item in caps["method_contracts"]:
            method = item["method"]
            check(method not in hints and method in caps["methods"], "分类重复或无对应方法")
            hints[method] = item
        for method in caps["methods"]:
            check(method not in profiles and method in methods and method in hints,
                  "profile join 冲突或缺项")
            profiles[method] = name
    rows = []
    for method in sorted(methods):
        profile = profiles.get(method, "access_machines" if method.startswith("machine.") else "unknown")
        check(profile != "unknown", "出现未审查 profile")
        branches = []
        for index, branch in enumerate(bundle["request"]["allOf"]):
            condition = branch.get("if", {}).get("properties", {}).get("method", {})
            if condition.get("const") == method or method in condition.get("enum", []):
                branches.append(f"#/allOf/{index}")
        hint = hints.get(method, {})
        transport = ("host_stdio_proxy" if profile == "host" else
                     "not_exposed" if profile == "access_machines" else
                     "persistent_local_stream" if method in STREAMS else "single_request_rpc")
        boundary = ("credential_custody_required" if method.startswith("uhp.token.") else
                    "management_required" if hint.get("scope") == "admin" else "review_required")
        rows.append(dict(zip(COLUMNS, [
            method, profile, transport, "conditional_branch" if branches else "generic_params_only",
            ";".join(branches) or "-", hint.get("scope", "missing"), hint.get("access", "missing"),
            str(hint["idempotent"]).lower() if hint else "missing", boundary,
            "unreviewed" if hint else "missing", "false",
        ])))
    return rows


# 将方法映射按固定列顺序渲染为 TSV 文本。
def render_map(rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=COLUMNS, delimiter="\t", lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


# 核对原文哈希、引用闭包与覆盖账本一致性，返回方法映射和引用出现次数。
def audit_sources():
    manifest = read_json(FIXTURE / "manifest.json")
    for name, info in manifest["files"].items():
        path = fixture_file(f"test/fixtures/luvus/0.14.3/linux/{name}")
        check(digest(path) == info["sha256"] and path.stat().st_size == info["bytes"],
              f"P0 原文改变: {name}")
    check(digest(FIXTURE / "schema-bundle.json") == SCHEMA_SHA, "原生 schema digest 不符")
    bundle = read_json(FIXTURE / "schema-bundle.json")
    session = read_json(FIXTURE / "session-capabilities.json")["result"]
    host = read_json(FIXTURE / "host-capabilities.json")["result"]
    docs = bundle["documents"]
    check(len(docs) == 29, "文档数改变")
    for key in ["request", "response", "event", "event_catalog"]:
        check(bundle[key] == docs[bundle[key]["$id"]], f"原文别名不符: {key}")
    for uri, doc in bundle["terminal"]["documents"].items():
        check(doc == docs[uri], f"terminal 别名不符: {uri}")
    references = 0

    # 递归检查 schema 引用均能在安装版文档集合内解析，并累计引用次数。
    def visit(value, base):
        nonlocal references
        if isinstance(value, dict):
            base = urljoin(base, value.get("$id", ""))
            if "$ref" in value:
                references += 1
                uri, fragment = urldefrag(urljoin(base, value["$ref"]))
                check(uri in docs, f"安装版引用不在 documents: {uri}")
                pointer(docs[uri], unquote(fragment))
            for item in value.values():
                visit(item, base)
        elif isinstance(value, list):
            for item in value:
                visit(item, base)

    for uri, doc in docs.items():
        check(doc.get("$id", uri) == uri, f"安装版 id/key 不符: {uri}")
        visit(doc, uri)
    rows = method_rows(bundle, session, host)
    ledger = {item["method"]: item for item in read_json(ROOT / "test/fixtures/native-contract/coverage.json")["methods"]}
    check(len(ledger) == len(rows), "P0 ledger 方法数不符")
    for row in rows:
        entry = ledger[row["method"]]
        check(all(entry[k] == row[k] for k in ["profile", "transport"]), "ledger 路由不符")
        check(entry["schema"]["parameter_detail"] == row["params_evidence"], "ledger 参数证据不符")
        check((";".join(entry["schema"]["branches"]) or "-") == row["request_branches"], "ledger 分支不符")
        check(entry["gateway_status"] == "not_implemented" and entry["gateway_permission"] == "not_enabled",
              "不能将原账本当运行许可")
    check(Counter(row["params_evidence"] for row in rows) ==
          {"generic_params_only": 144, "conditional_branch": 79}, "参数计数不符")
    check(all(row["profile"] == "session" for row in rows if row["params_evidence"] == "generic_params_only"),
          "generic profile 不符")
    check("terminal.frame" not in bundle["event_catalog"]["properties"] and
          "terminal.resync_required" not in bundle["event_catalog"]["properties"], "终端特殊事件改变")
    return rows, references


# 从内嵌值或精确选中的 fixture 片段构造独立种子副本。
def materialize_seed(spec):
    if "value" in spec:
        return copy.deepcopy(spec["value"])
    source = read_json(fixture_file(spec["artifact"]))
    if "select" in spec:
        selected = [item for item in source if all(item.get(k) == v for k, v in spec["select"].items())]
        check(len(selected) == 1, f"seed 必须精确选中一条记录: {spec['select']}")
        source = selected[0][spec["json_field"]]
        source = json.loads(source)
    return copy.deepcopy(pointer(source, spec.get("pointer", "")))


# 按草案执行根替换或子路径设置、删除，并返回变更后的输入。
def mutate(value, change):
    path = change["path"]
    if path == "":
        check(change["op"] == "set", "根变更必须是 set")
        return copy.deepcopy(change["value"])
    parent_path, _, key = path.rpartition("/")
    parent = pointer(value, parent_path)
    key = key.replace("~1", "/").replace("~0", "~")
    key = int(key) if isinstance(parent, list) else key
    if change["op"] == "remove":
        del parent[key]
    elif change["op"] == "set":
        parent[key] = copy.deepcopy(change["value"])
    else:
        raise ValueError(f"未知 fixture 变更: {change['op']}")
    return value


# 检查草案阶段、正反例和边界生成器齐全且输入可序列化，返回数量摘要。
def audit_matrix():
    matrix = read_json(MATRIX)
    check(matrix["status"] == "proposal_not_executed" and matrix["base_commit"] == BASE,
          "矩阵状态或基线改变")
    seeds = {name: materialize_seed(spec) for name, spec in matrix["seeds"].items()}
    cases = matrix["cases"]
    identifiers = [case["id"] for case in cases]
    check(len(identifiers) == len(set(identifiers)), "case id 重复")
    required_stages = {"bundle", "capabilities", "request", "response", "event", "control",
                       "dispatch", "late", "parse", "stream", "result"}
    check({case["stage"] for case in cases} == required_stages, "矩阵阶段缺失")
    for stage in required_stages:
        check({case["expected"]["verdict"] for case in cases if case["stage"] == stage} >=
              {"accept", "reject"}, f"阶段缺正反例: {stage}")
    generators = {"depth_65", "bundle_bytes_over_2mib", "ref_chain_33", "utf8_text_over_65536",
                  "all_generic_methods", "anchor_each_field_mismatch"}
    used_generators = set()
    for case in cases:
        expected = case["expected"]
        check(expected["assertions"], f"缺少具体断言: {case['id']}")
        if "generator" in case:
            check(case["generator"] in generators, "未知矩阵生成器")
            used_generators.add(case["generator"])
        else:
            check(case["seed"] in seeds, f"seed 缺失: {case['id']}")
            value = copy.deepcopy(seeds[case["seed"]])
            for change in case.get("mutations", []):
                value = mutate(value, change)
            # 这里只检查草案输入能序列化，绝不把它当 schema/安全验收。
            json.dumps(value, ensure_ascii=False, allow_nan=False)
        if case["stage"] == "dispatch" and expected["verdict"] == "reject":
            check(expected.get("dispatch_count") == 0, f"拒绝必须无派发: {case['id']}")
    check(used_generators == generators, "边界生成器缺失")
    required = {"Q-generic-structure", "D-generic-strict", "D-safety-missing", "D-safety-unknown",
                "D-safety-invalid", "D-safety-untrusted", "D-owner-missing", "D-raw-missing",
                "D-future-missing", "D-forged-class", "D-admin-owner", "D-token-result",
                "R-error-data", "E-terminal-resync", "L-discard", "L-anchor-fields",
                "O-secret-inline", "O-secret-handle", "O-secret-late", "O-future-secret"}
    check(required <= set(identifiers), "关键安全/契约用例缺失")
    return len(seeds), len(cases), dict(sorted(Counter(case["stage"] for case in cases).items()))


# 核对终端映射完整对应原生能力，并确认运行时未启用且高级能力仍延后。
def audit_terminal_map():
    bundle = read_json(FIXTURE / "schema-bundle.json")
    terminal = read_json(FIXTURE / "session-capabilities.json")["result"]["terminal"]
    with (MAPPINGS / "terminal-capability-map.tsv").open(encoding="utf-8") as source:
        rows = list(csv.DictReader(source, delimiter="\t"))
    check(len(rows) == 26, "终端能力/feature 行数不符")
    check(len({(row["kind"], row["name"]) for row in rows}) == len(rows), "终端映射重复")
    for kind, key in [("capability", "capabilities"), ("feature", "features")]:
        check({row["name"] for row in rows if row["kind"] == kind} == set(terminal[key]),
              f"终端 {key} 未完整映射")
    methods = set(bundle["request"]["properties"]["method"]["enum"])
    actions = set(bundle["terminal"]["control_frame"]["properties"]["action"]["enum"])
    for row in rows:
        check(set(row["native_method"].split(";")) <= methods, "终端方法未登记")
        check(row["control_action"] == "-" or row["control_action"] in actions, "终端 action 未登记")
        check(row["runtime_enabled"] == "false", "不能将提案表当已启用能力")
        if row["name"].startswith("upload_") or row["name"] == "paste_image":
            check(row["initial_adapter_plan"] == "deferred_no_native_adapter_evidence",
                  "高级图片/上传不得自动启用")
    return len(rows)


# 执行资料审计，按参数重建方法映射，并输出仅限设计材料检查的摘要。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-map", action="store_true", help="仅重建原生方法映射 TSV")
    args = parser.parse_args()
    rows, references = audit_sources()
    mapping = MAPPINGS / "native-method-map.tsv"
    content = render_map(rows)
    if args.write_map:
        mapping.write_text(content, encoding="utf-8")
    check(mapping.read_text(encoding="utf-8") == content, "设计映射与原文不一致")
    terminal_rows = audit_terminal_map()
    seeds, cases, stages = audit_matrix()
    print(json.dumps({"scope": "design_materials_only_not_validator_or_bun_tests",
                      "base_commit": BASE, "schema_sha256": SCHEMA_SHA,
                      "methods": len(rows), "generic_params_only": 144,
                      "conditional_branch": 79, "documents": 29,
                      "terminal_capability_and_feature_rows": terminal_rows,
                      "installed_reference_occurrences_resolved": references,
                      "seeds_materialized": seeds, "case_drafts": cases,
                      "drafts_by_stage": stages, "validator_cases_executed": 0}, indent=2))


if __name__ == "__main__":
    main()
