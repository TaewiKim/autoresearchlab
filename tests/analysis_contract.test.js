"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { currentAnalysisContract, bindAnalystPlan, repairQueuedAnalystContracts, registerSpec } = require("../src/policy/analysis_contract");
const { runnerLeadMatchScore } = require("../src/agents/shared/lead_evidence_match");
const { pipelineHealthFindings } = require("../src/orchestrator/pipeline_health");
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-contract-")), root = path.join(cwd, ".research-lab");
  const write = (p,v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p,JSON.stringify(v)); };
  write(path.join(root,"state","c-analysis-contract-policy.json"),{enabled:true,specs:{curves:{comparator:"retrieval",required_contrast_ids:["p1","p2"]}}});
  write(path.join(root,"state","c-lab-director-hypothesis.json"),{selected_hypothesis:{primary_family:"curves",statement:"Every policy differs from retrieval.",dataset_or_accession:"/data/bundle/episodes.csv",identification_strategy:{estimands:["each policy minus retrieval"]}}});
  return {cwd,root,write};
}
test("canonical version changes when the scientific estimand changes",()=>{
  const f=fixture(), a=currentAnalysisContract(f.root,"c");
  f.write(path.join(f.root,"state","c-lab-director-hypothesis.json"),{selected_hypothesis:{primary_family:"curves",statement:"One policy differs from BC.",dataset_or_accession:"/data/bundle/episodes.csv"}});
  assert.notEqual(currentAnalysisContract(f.root,"c").contract_id,a.contract_id);
});
test("a new scientific family can preregister its exact specification and cannot overwrite it",()=>{
  const f=fixture(), policy=path.join(f.root,"state","c-analysis-contract-policy.json");
  f.write(policy,{enabled:true,specs:{}});
  const before=currentAnalysisContract(f.root,"c"),laneId="followup-analyst-1",dir=path.join(f.root,"lanes","c",laneId);
  f.write(path.join(dir,"role-plan.json"),{role:"analyst",planner_metadata:{}});
  const specPath=path.join(dir,"spec.json");
  f.write(specPath,{base_contract_id:before.contract_id,canonical_statement:before.statement,canonical_estimands:before.estimands,comparator:"retrieval",required_contrast_ids:["p1","p2"],dataset_sha256:"a".repeat(64)});
  const after=registerSpec({cwd:f.cwd,cycleId:"c",laneId,specPath});
  assert.notEqual(before.contract_id,after.contract_id);
  assert.equal(after.operational_spec.comparator,"retrieval");
  assert.throws(()=>registerSpec({cwd:f.cwd,cycleId:"c",laneId,specPath}),/cannot be overwritten/);
});
test("binding removes stale comparator instructions without rewriting executed history",()=>{
  const f=fixture(), c=currentAnalysisContract(f.root,"c"), p={assigned_hypotheses:["one policy minus BC"],planner_metadata:{candidate_hypotheses:[{statement:"old mean contrast"}]}};
  assert.equal(bindAnalystPlan(p,c),true);
  assert.deepEqual(p.assigned_hypotheses,[c.statement]);
  assert.deepEqual(p.analysis_goals,c.estimands);
  assert.equal(bindAnalystPlan(p,c),false);
});
test("analysts re-check the live contract before submitting a handoff",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-18: analysts 966 and 998
  // obeyed the contract in their role plan, but a new contract became current
  // during each lane and their completed primary handoffs were discarded.
  const f=fixture(), c=currentAnalysisContract(f.root,"c"), p={planner_metadata:{}};
  assert.equal(bindAnalystPlan(p,c),true);
  assert.equal(p.planner_metadata.analysis_contract_binding_version,5);
  assert.match(p.followup_description,/Immediately before writing the final handoff/);
  assert.match(p.followup_description,/--current/);
  assert.match(p.followup_description,/revise the handoff and frozen blueprint to match it before completing/);
});
test("pending analysts are rebound to regenerate incomplete primary contrast rows",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-16: runner 347 emitted
  // the registered table but mixed descriptive estimates with three blank
  // simultaneous intervals, and the version-2 assignment did not tell the
  // pending Analysts which complete output alternatives the verifier accepts.
  const f=fixture(), c=currentAnalysisContract(f.root,"c"), p={
    assigned_hypotheses:[c.statement],
    followup_description:"emit primary_contrasts.csv with the required IDs",
    planner_metadata:{analysis_contract:c,analysis_contract_binding_version:2},
  };
  const runner=path.join(f.root,"lanes","c","followup-runner-347");
  f.write(path.join(runner,"lane-contract.json"),{role:"lab-runner"});
  f.write(path.join(runner,"result.json"),{analysis_contract_validation:{
    contract_id:c.contract_id,status:"mismatch",evidence_role:"primary",
    problems:["primary_contrast_estimates_missing"]}});
  f.write(path.join(runner,"final-status.json"),{status:"completed",completed_at:new Date().toISOString(),result_path:path.join(runner,"result.json")});
  const analyst=path.join(f.root,"lanes","c","followup-analyst-866");
  f.write(path.join(analyst,"lane-contract.json"),{role:"analyst"});
  f.write(path.join(analyst,"role-plan.json"),{role:"analyst",...p});
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[
    {lane_id:"followup-runner-347",status:"completed"},{lane_id:"followup-analyst-866",status:"pending"}]});
  const found=pipelineHealthFindings({cwd:f.cwd,cycleId:"c"}).filter(x=>x.subtype==="analysis_contract_mismatch");
  assert.deepEqual(found.map(x=>x.lane_ids),[["followup-runner-347"]]);
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),["followup-analyst-866"]);
  const rebound=JSON.parse(fs.readFileSync(path.join(analyst,"role-plan.json")));
  assert.equal(rebound.planner_metadata.analysis_contract_binding_version,5);
  assert.match(rebound.followup_description,/finite estimate, simultaneous_lower, and simultaneous_upper/);
  assert.match(rebound.followup_description,/never mix descriptive estimates with missing bounds/);
  assert.match(rebound.followup_description,/exactly one new immutable validation run/);
  assert.equal(bindAnalystPlan(rebound,c),false);
});
test("mixed comparators encoded by registered contrast IDs become canonical before rebinding",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-16: runner 359 used
  // behavior_transformer and hact_vq for the corresponding registered minus
  // contrasts, but the underspecified contract exposed only chunked_bc.
  const f=fixture(), policy=path.join(f.root,"state","c-analysis-contract-policy.json");
  f.write(policy,{enabled:true,specs:{curves:{
    comparator:"chunked_bc", required_contrast_ids:[
      "diffusion_route_area_vs_chunked_bc",
      "diffusion_route_area_minus_behavior_transformer",
      "diffusion_route_area_minus_hact_vq",
    ],
  }}});
  const contract=currentAnalysisContract(f.root,"c");
  assert.deepEqual(contract.operational_spec.contrast_comparators,{
    diffusion_route_area_vs_chunked_bc:"chunked_bc",
    diffusion_route_area_minus_behavior_transformer:"behavior_transformer",
    diffusion_route_area_minus_hact_vq:"hact_vq",
  });
  const plan={planner_metadata:{}};
  assert.equal(bindAnalystPlan(plan,contract),true);
  assert.equal(plan.planner_metadata.analysis_contract_binding_version,5);
  assert.match(plan.followup_description,/contrast_comparators\[contrast_id\]/);
});
test("only verified outputs with the current contract bind, even under a family alias",()=>{
  const f=fixture(), c=currentAnalysisContract(f.root,"c"), lead={hasIdentity:true,family:"curves",datasets:new Set(["bundle"]),contractId:c.contract_id};
  const r={dataset_root:"/data/bundle",hypothesis_results:[{family:"alias"}],analysis_contract_validation:{contract_id:c.contract_id,status:"verified",evidence_role:"primary"}};
  assert.equal(runnerLeadMatchScore(r,lead),3);
  for(const patch of [{contract_id:"old"},{status:"mismatch"},{evidence_role:"supporting"}])assert.equal(runnerLeadMatchScore({...r,analysis_contract_validation:{...r.analysis_contract_validation,...patch}},lead),0);
  assert.equal(runnerLeadMatchScore({...r,dataset_root:"/other/bundle2"},lead),0);
});
test("maintainer automatically rebinds pending analysts and leaves completed history alone",()=>{
  const f=fixture();
  for(const id of ["followup-analyst-1","followup-analyst-2"]){
    const d=path.join(f.root,"lanes","c",id);
    f.write(path.join(d,"lane-contract.json"),{role:"analyst"});
    f.write(path.join(d,"role-plan.json"),{role:"analyst",assigned_hypotheses:["old BC mean"],planner_metadata:{}});
  }
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[{lane_id:"followup-analyst-1",status:"pending"},{lane_id:"followup-analyst-2",status:"completed"}]});
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),["followup-analyst-1"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-2","role-plan.json"))).assigned_hypotheses,["old BC mean"]);
});
test("one pending analyst receives the measured current-contract execution failure",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-17: followup-runner-420
  // lacked both its primary contrast table and executed contract ID, but pending
  // Analysts 938-940 were already binding-version 4 and received no failure
  // context with which to regenerate the rank-deficient frozen blueprint.
  const f=fixture(),c=currentAnalysisContract(f.root,"c"),runner=path.join(f.root,"lanes","c","followup-runner-420");
  f.write(path.join(runner,"lane-contract.json"),{role:"lab-runner"});
  f.write(path.join(runner,"result.json"),{
    executed_handoff_path:"/lanes/followup-analyst-936/handoff-validation-plan.json",
    analysis_contract_validation:{contract_id:c.contract_id,status:"mismatch",evidence_role:"primary",
      problems:["one_primary_contrast_table_required","executed_contract_id_missing"]},
    analysis_trace:{blueprints:[{blueprint_id:"BP-LOSS-REFINEMENT-SUPPORT-01",status:"failed"}]},
    blueprint_executions:[{blueprint_id:"BP-LOSS-REFINEMENT-SUPPORT-01",check_id:"LOSS-REFINEMENT-SUPPORT-PRIMARY-01",
      status:"failed",error:"Adjusted slope design matrix is rank deficient",script_path:"/artifacts/script.py"}],
  });
  f.write(path.join(runner,"final-status.json"),{status:"completed",completed_at:"2026-10-17T11:07:52Z",result_path:path.join(runner,"result.json")});
  for(const [id,action] of [["938","novelty_followup"],["939","runner_result_interpretation_followup"],["940","chronicle_evidence_request_followup"]]){
    const dir=path.join(f.root,"lanes","c",`followup-analyst-${id}`);
    f.write(path.join(dir,"lane-contract.json"),{role:"analyst"});
    f.write(path.join(dir,"role-plan.json"),{role:"analyst",action_type:action,assigned_hypotheses:[c.statement],
      followup_description:"already current",planner_metadata:{analysis_contract:c,analysis_contract_binding_version:5,
        ...(id==="939"?{review_action:{analysis_request:{analyst_handoff:{analysis_contract:{contract_id:"analysis:retired"}}}},
          failed_runner_context:{analysis_contract_validation:{contract_id:"analysis:retired",status:"verified"}}}:{})}});
  }
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[
    {lane_id:"followup-runner-420",status:"completed"},
    {lane_id:"followup-analyst-938",status:"pending"},{lane_id:"followup-analyst-939",status:"pending"},
    {lane_id:"followup-analyst-940",status:"pending"}]});
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),["followup-analyst-939"]);
  const owner=JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-939","role-plan.json")));
  assert.equal(owner.planner_metadata.failed_runner_context.lane_id,"followup-runner-420");
  assert.deepEqual(owner.analysis_request.failed_runner_context.analysis_contract_validation.problems,
    ["one_primary_contrast_table_required","executed_contract_id_missing"]);
  assert.equal(owner.planner_metadata.review_action,undefined);
  assert.match(owner.followup_description,/rank deficient|one_primary_contrast_table_required/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-938","role-plan.json"))).planner_metadata.failed_runner_context,undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-940","role-plan.json"))).planner_metadata.failed_runner_context,undefined);
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),[]);
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[
    {lane_id:"followup-runner-420",status:"completed"},
    {lane_id:"followup-analyst-938",status:"pending"},{lane_id:"followup-analyst-939",status:"completed"},
    {lane_id:"followup-analyst-940",status:"pending"}]});
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),[]);
});
test("a preflight-blocked runner routes its failure to one pending analyst",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-26: runners 745-747
  // recorded executed_dataset_hash_mismatch only in analysis-contract-preflight.json;
  // without result.json, all already-bound pending Analysts missed regeneration.
  const f=fixture(),c=currentAnalysisContract(f.root,"c");
  const runner=path.join(f.root,"lanes","c","followup-runner-747");
  const handoff=path.join(f.root,"lanes","c","followup-analyst-1284","handoff-validation-plan.json");
  f.write(path.join(runner,"lane-contract.json"),{role:"lab-runner"});
  f.write(path.join(runner,"role-plan.json"),{role:"lab-runner",planner_metadata:{analyst_handoff_path:handoff}});
  f.write(path.join(runner,"analysis-contract-preflight.json"),{
    contract_id:c.contract_id,status:"blocked",evidence_role:"primary",problems:["executed_dataset_hash_mismatch"]});
  f.write(path.join(runner,"final-status.json"),{status:"failed",completed_at:"2026-10-26T11:11:42Z"});
  for(const id of ["1286","1288"]){
    const dir=path.join(f.root,"lanes","c",`followup-analyst-${id}`);
    f.write(path.join(dir,"lane-contract.json"),{role:"analyst"});
    const plan={role:"analyst",action_type:id==="1286"?"methods_followup":"gate_restart_followup",planner_metadata:{}};
    bindAnalystPlan(plan,c);
    f.write(path.join(dir,"role-plan.json"),plan);
  }
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[
    {lane_id:"followup-runner-747",role:"lab-runner",status:"failed"},
    {lane_id:"followup-analyst-1286",role:"analyst",status:"pending"},
    {lane_id:"followup-analyst-1288",role:"analyst",status:"pending"}]});

  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),["followup-analyst-1286"]);
  const owner=JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-1286","role-plan.json")));
  assert.equal(owner.planner_metadata.failed_runner_context.lane_id,"followup-runner-747");
  assert.equal(owner.planner_metadata.failed_runner_context.result_path,null);
  assert.equal(owner.planner_metadata.failed_runner_context.executed_handoff_path,handoff);
  assert.match(owner.planner_metadata.failed_runner_context.preflight_path,/analysis-contract-preflight\.json$/);
  assert.deepEqual(owner.planner_metadata.failed_runner_context.analysis_contract_validation.problems,
    ["executed_dataset_hash_mismatch"]);
  assert.match(owner.followup_description,/preflight_path, role_plan_path, result_path when present/);
  const other=JSON.parse(fs.readFileSync(path.join(f.root,"lanes","c","followup-analyst-1288","role-plan.json")));
  assert.equal(other.planner_metadata.failed_runner_context,undefined);
  assert.deepEqual(repairQueuedAnalystContracts({cwd:f.cwd,cycleId:"c"}),[]);
});
test("a first contract mismatch becomes a maintainer finding without requiring three crashes",()=>{
  const f=fixture(),c=currentAnalysisContract(f.root,"c"),d=path.join(f.root,"lanes","c","followup-runner-1");
  f.write(path.join(d,"lane-contract.json"),{role:"lab-runner"});
  f.write(path.join(d,"analysis-contract-preflight.json"),{contract_id:c.contract_id,status:"blocked",problems:["primary_claim_text_mismatch"]});
  const found=pipelineHealthFindings({cwd:f.cwd,cycleId:"c"}).filter(x=>x.subtype==="analysis_contract_mismatch");
  assert.equal(found.length,1);
  assert.equal(found[0].contract_id,c.contract_id);
});
test("an analyst bound to a measured contract is told its numbers, and after two is not asked for a third run",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-18: 18 runners executed
  // contract 12daf336 and wrote the same four estimates each time.
  const { contractMeasurements } = require("../src/policy/analysis_contract");
  const f=fixture(), c=currentAnalysisContract(f.root,"c");
  const runner=(id,status)=>{
    const dir=path.join(f.root,"lanes","c",id), table=path.join(dir,"primary_contrasts.csv");
    f.write(path.join(dir,"analysis-contract-preflight.json"),{contract_id:c.contract_id,status:"ready",evidence_role:"primary"});
    fs.writeFileSync(table,"contrast_id,estimate,simultaneous_lower,simultaneous_upper\np1,0.8992,0.1585,1.64\np2,0.2203,-0.9841,1.42\n");
    f.write(path.join(dir,"result.json"),{analysis_contract_validation:{contract_id:c.contract_id,status,evidence_role:"primary",problems:[]},
      blueprint_executions:[{tables:[{name:"primary_contrasts.csv",path:table}]}]});
  };
  const lanes=(ids)=>f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:ids.map((lane_id)=>({lane_id,status:"completed"}))});
  runner("followup-runner-458","verified"); runner("followup-runner-446","mismatch");
  lanes(["followup-runner-446","followup-runner-458"]);
  const once=contractMeasurements(f.root,"c",c.contract_id);
  assert.deepEqual(once.map(x=>x.lane_id),["followup-runner-458"]);
  assert.deepEqual(once[0].primary_contrasts[0],{contrast_id:"p1",estimate:"0.8992",simultaneous_lower:"0.1585",simultaneous_upper:"1.64",status:null});
  const p={planner_metadata:{}};
  assert.equal(bindAnalystPlan(p,c,null,once),true);
  assert.match(p.followup_description,/already available: verified execution followup-runner-458 \(p1=0\.8992 \[0\.1585, 1\.64\]/);
  assert.match(p.followup_description,/exactly one new immutable validation run/);
  assert.match(p.followup_description,/One independent reproduction/);
  assert.equal(bindAnalystPlan(p,c,null,once),false);

  runner("followup-runner-459","verified");
  lanes(["followup-runner-446","followup-runner-458","followup-runner-459"]);
  const twice=contractMeasurements(f.root,"c",c.contract_id);
  assert.equal(bindAnalystPlan(p,c,null,twice),true);
  assert.doesNotMatch(p.followup_description,/exactly one new immutable validation run/);
  assert.match(p.followup_description,/runs no further primary execution of this measurement specification/);
  assert.match(p.followup_description,/analysis_evidence_role=supporting/);
  assert.deepEqual(p.planner_metadata.analysis_contract_measurements.map(x=>x.lane_id),["followup-runner-458","followup-runner-459"]);
});

test("a result-informed lead rewrite retains measurements of the same registered specification",()=>{
  // MEASURED ON cycle-a-20260919, 2026-10-18: runners 486/487
  // measured the registered seven contrasts; the lead then restated those
  // results, changing its contract ID, and analysts 1017/1018 were asked to
  // create runners 493/494 for the identical data and estimands.
  const { contractMeasurements } = require("../src/policy/analysis_contract");
  const f=fixture(),current=currentAnalysisContract(f.root,"c");
  current.operational_spec={
    analysis_evidence_role:"primary",base_contract_id:"analysis:new-base",
    canonical_statement:"The measured result.",canonical_estimands:["policy minus retrieval"],
    comparator:"retrieval",required_contrast_ids:["p1","p2"],dataset_sha256:"a".repeat(64),
    decision_margin:0.05,
  };
  current.contract_id="analysis:72e2799d";
  const old={...current,contract_id:"analysis:9e5d264d",statement:"The prospective claim.",operational_spec:{
    ...current.operational_spec,base_contract_id:"analysis:old-base",canonical_statement:"The prospective claim.",
    canonical_estimands:["each policy minus retrieval"],
  }};
  const ids=["followup-runner-486","followup-runner-487"];
  for(const id of ids){
    const dir=path.join(f.root,"lanes","c",id),table=path.join(dir,"primary_contrasts.csv");
    f.write(path.join(dir,"role-plan.json"),{role:"lab-runner",planner_metadata:{analysis_request:{analyst_handoff:{analysis_contract:old}}}});
    f.write(path.join(dir,"analysis-contract-preflight.json"),{contract_id:old.contract_id,status:"ready",evidence_role:"primary"});
    fs.writeFileSync(table,"contrast_id,estimate,simultaneous_lower,simultaneous_upper\np1,1.02016258,0.96453004,1.07579512\np2,0.00502,-0.02564,0.03568\n");
    f.write(path.join(dir,"result.json"),{analysis_contract_validation:{contract_id:old.contract_id,status:"verified",evidence_role:"primary"},
      blueprint_executions:[{tables:[{name:"primary_contrasts.csv",path:table}]}]});
  }
  const incomplete="followup-runner-485",incompleteDir=path.join(f.root,"lanes","c",incomplete);
  f.write(path.join(incompleteDir,"role-plan.json"),{role:"lab-runner",planner_metadata:{analysis_request:{analyst_handoff:{analysis_contract:old}}}});
  f.write(path.join(incompleteDir,"analysis-contract-preflight.json"),{contract_id:old.contract_id,status:"ready",evidence_role:"primary"});
  f.write(path.join(incompleteDir,"result.json"),{});
  f.write(path.join(f.root,"state","c-cycle-run-state.json"),{lane_statuses:[incomplete,...ids].map((lane_id)=>({lane_id,status:"completed"}))});
  const measured=contractMeasurements(f.root,"c",current);
  assert.deepEqual(measured.map(x=>x.lane_id),ids);
  const analyst={planner_metadata:{}};
  assert.equal(bindAnalystPlan(analyst,current,null,measured),true);
  assert.deepEqual(analyst.planner_metadata.analysis_contract_measurements.map(x=>x.lane_id),ids);
  assert.doesNotMatch(analyst.followup_description,/exactly one new immutable validation run/);
  assert.match(analyst.followup_description,/runs no further primary execution of this measurement specification/);
});
