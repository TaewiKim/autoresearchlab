import csv
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
import hashlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drivers/analysis'))
from python_stats_lib.analysis_contract import preflight, verify_outputs
from python_stats_lib.blueprint_model import Blueprint
from python_stats_lib.blueprint_run import _run_blueprint
import json

class AnalysisContractTests(unittest.TestCase):
    def test_a_policy_mean_or_one_passing_policy_cannot_confirm_an_all_policy_conjunction(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'primary_contrasts.csv'
            ids=[f'{policy}:{axis}' for policy in ['p1','p2'] for axis in ['pose','friction','cross_axis']]
            with p.open('w',newline='') as f:
                writer=csv.writer(f);writer.writerow(['contrast_id','comparator','estimate','simultaneous_lower','simultaneous_upper'])
                for id in ids:
                    interval=[.1,.08,.12] if id.startswith('p1:') else [0,0,0]
                    writer.writerow([id,'retrieval',*interval])
            c={'contract_id':'current','operational_spec':{'required_contrast_ids':ids,'comparator':'retrieval','margin':.05,'policies':['p1','p2'],'axes':['pose','friction'],'support_quantifier':'each learned policy on at least one axis AND at least one policy cross-axis contrast'}}
            run=SimpleNamespace(tables=[{'name':p.name,'path':str(p)}],metrics={'analysis_contract_id':'current','pass_fail':'pass'},script_path=None)
            binding={'contract_id':'current','evidence_role':'primary','status':'ready'}
            self.assertIn('scientific_decision_does_not_match_registered_quantifier',verify_outputs([run],c,binding)['problems'])
            run.metrics['pass_fail']='fail'
            self.assertEqual(verify_outputs([run],c,binding)['status'],'verified')

    def test_driver_records_actual_command_and_provides_contract_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            script="import json,os;from pathlib import Path;c=json.loads(Path(os.environ['RESEARCHLAB_ANALYSIS_CONTRACT']).read_text());print(json.dumps({'check_id':'receipt','pass_fail':'pass','analysis_contract_id':c['contract_id'],'value':1.0}))"
            b=Blueprint(blueprint_id='receipt',check_id='receipt',code=script,entrypoint=None,dataset=None,outcome=None,raw={'analysis_contract':{'contract_id':'current'}})
            run=_run_blueprint(b,csv_root=root,output_root=root/'out',timeout_seconds=30,derived_indicators_for_blueprint=[])
            self.assertEqual(run.status,'completed',run.error)
            self.assertEqual(run.metrics['analysis_contract_id'],'current')
            receipt=json.loads((Path(run.output_dir)/'driver-execution-receipt.json').read_text())
            self.assertEqual(receipt['return_code'],0)
            self.assertEqual(receipt['argv'][0],sys.executable)
            self.assertEqual(receipt['script_sha256'],hashlib.sha256(Path(run.script_path).read_bytes()).hexdigest())

    def test_mismatched_claim_and_missing_handoff_fail_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'episodes.csv'; p.write_text('x\n1\n')
            c={'contract_id':'current','statement':'all policies vs retrieval','operational_spec':{'dataset_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}}
            good={'analysis_contract':c,'primary_hypothesis_id':'current','validation_targets':[{'claim_text':c['statement']}],'handoff_checks':[{'dataset':str(p),'column_mapping':{}}]}
            self.assertEqual(preflight(good,c,None)['status'],'ready')
            for patch in [{'primary_hypothesis_id':'old'}, {'validation_targets':[{'claim_text':'mean vs BC'}]}, {'analysis_contract':{}}, {'handoff_checks':[{'dataset':str(p),'column_mapping':[]}]}]:
                bad={**good,**patch}
                if patch.get('handoff_checks'):
                    bad['primary_hypothesis_id']='old'
                with self.assertRaisesRegex(ValueError,'analysis_contract_mismatch'):
                    preflight(bad,c,None)

    def test_exact_primary_family_and_comparator_are_checked_from_actual_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'primary_contrasts.csv'
            def write(ids, comparator):
                with p.open('w',newline='') as f:
                    w=csv.writer(f);w.writerow(['contrast_id','comparator','estimate','simultaneous_lower','simultaneous_upper'])
                    for id in ids:w.writerow([id,comparator,0.1,0.02,0.18])
            c={'contract_id':'current','operational_spec':{'required_contrast_ids':['a','b'],'comparator':'retrieval'}}
            b={'contract_id':'current','evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(tables=[{'name':p.name,'path':str(p)}],metrics={'analysis_contract_id':'current'},script_path=None)
            write(['a','b'],'retrieval');self.assertEqual(verify_outputs([run],c,b)['status'],'verified')
            write(['a','b'],'BC');self.assertIn('primary_comparator_mismatch',verify_outputs([run],c,b)['problems'])
            write(['a'],'retrieval');self.assertIn('primary_contrast_family_mismatch',verify_outputs([run],c,b)['problems'])

    def test_registered_per_contrast_comparator_labels_are_accepted(self):
        # MEASURED ON cycle-a-20260919, 2026-10-14: a valid predictive-
        # gain row used designed_axis_label while policy rows used retrieval, all
        # in the blueprint's comparator_label column.
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'primary_contrasts.csv'
            with p.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['contrast_id','comparator_label','estimate','simultaneous_lower','simultaneous_upper'])
                w.writerow(['gain','designed_axis_label',0.2,0.1,0.3])
                w.writerow(['policy','retrieval',0.1,0.02,0.18])
            c={'contract_id':'current','operational_spec':{'required_contrast_ids':['gain','policy'],
                'comparator':'retrieval','contrast_comparators':{'gain':'designed_axis_label','policy':'retrieval'}}}
            b={'contract_id':'current','evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(tables=[{'name':p.name,'path':str(p)}],metrics={'analysis_contract_id':'current'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b)['status'],'verified')
            with p.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['contrast_id','comparator_label','estimate','simultaneous_lower','simultaneous_upper'])
                w.writerow(['gain','retrieval',0.2,0.1,0.3]);w.writerow(['policy','retrieval',0.1,0.02,0.18])
            self.assertIn('primary_comparator_mismatch',verify_outputs([run],c,b)['problems'])

    def test_failed_preregistered_gates_preserve_contract_bound_inconclusive(self):
        # MEASURED ON cycle-a-20260919, 2026-10-16: runner 342 emitted
        # every required contrast as not_estimable_design_invalid after its
        # competence, activation, and transition-support gates failed, but the
        # verifier reported primary_contrast_estimates_missing and caused churn.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['contrast_id','comparator','estimate','simultaneous_ci_lower','simultaneous_ci_upper','status'])
                w.writerow(['raw_gap:diffusion_policy:initial_pose','chunked_bc','','','','not_estimable_design_invalid'])
                w.writerow(['corrected_residual:chunked_bc_darp:act:signed_friction','chunked_bc_darp','','','','not_estimable_design_invalid'])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['gate','observed','operator','threshold','passed'])
                w.writerow(['competence',.2,'>=',.8,False])
                w.writerow(['pairing',1.0,'>=',.99,True])
            c={'contract_id':'analysis:e90393','operational_spec':{
                'required_contrast_ids':['raw_gap:diffusion_policy:initial_pose','corrected_residual:chunked_bc_darp:act:signed_friction'],
                'comparator':'chunked_bc','contrast_comparators':{
                    'raw_gap:diffusion_policy:initial_pose':'chunked_bc',
                    'corrected_residual:chunked_bc_darp:act:signed_friction':'chunked_bc_darp'},
                'validity_gates':{'competence_min':.8,'pairing_min':.99}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'inconclusive',
                    'resolution_status':'invalid_design_precondition'},script_path=None)
            result=verify_outputs([run],c,b)
            self.assertEqual(result['status'],'verified')
            self.assertEqual(result['problems'],[])
            self.assertEqual(run.metrics['pass_fail'],'inconclusive')

            gates.write_text('gate,observed,operator,threshold,passed\ncompetence,1.0,>=,.8,True\n')
            self.assertIn('primary_contrast_estimates_missing',verify_outputs([run],c,b)['problems'])
            gates.write_text('gate,observed,operator,threshold,passed\ncompetence,.2,>=,.8,False\n')
            run.metrics['resolution_status']=None
            self.assertIn('primary_contrast_estimates_missing',verify_outputs([run],c,b)['problems'])

    def test_canonical_design_invalid_vocabulary_and_hypothesis_gates_are_verified(self):
        # MEASURED ON cycle-a-20260919, 2026-10-16: runner 356 used
        # gate_id, emitted not_estimable_design_invalid for all eight blank
        # primary rows, and proved two thresholds from the canonical hypothesis;
        # the verifier nevertheless reported primary_contrast_estimates_missing.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            ids=[
                'diffusion_policy__route_area_advantage_interaction__vs_chunked_bc',
                'flow_matching__route_area_advantage_interaction__vs_chunked_bc',
                'diffusion_policy__one_route_area_advantage__vs_chunked_bc',
                'flow_matching__one_route_area_advantage__vs_chunked_bc',
                'diffusion_policy__initial_pose__route_support_slope_interaction__vs_chunked_bc',
                'diffusion_policy__signed_friction__route_support_slope_interaction__vs_chunked_bc',
                'flow_matching__initial_pose__route_support_slope_interaction__vs_chunked_bc',
                'flow_matching__signed_friction__route_support_slope_interaction__vs_chunked_bc']
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['contrast_id','comparator','estimate','simultaneous_lower','simultaneous_upper','status'])
                for contrast_id in ids:
                    w.writerow([contrast_id,'chunked_bc','','','','not_estimable_design_invalid'])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow(['gate_id','operator','threshold','observed','passed'])
                w.writerow(['transition_support','>=',.25,.09375,False])
                w.writerow(['active_compute_ratio','<=',1.10,95.0312556705902,False])
            c={'contract_id':'analysis:7ad2046','falsification_conditions':[
                'Classify the design as invalid if active-compute ratio is above 1.10, transition support is below 0.25, or either oracle gradient is above 0.10.'],
                'operational_spec':{'required_contrast_ids':ids,'comparator':'chunked_bc'}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'inconclusive',
                    'resolution_status':'not_estimable_design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b)['status'],'verified')
            c['falsification_conditions']=[
                'Classify the design as invalid if active-compute ratio is above 1.20 or transition support is below 0.30.']
            self.assertIn('primary_contrast_estimates_missing',verify_outputs([run],c,b)['problems'])

    def test_combined_registered_threshold_columns_preserve_design_invalid_result(self):
        # MEASURED ON cycle-a-20260919, 2026-10-16: runner 370 emitted
        # all required blank rows after realized_support_reduction failed, using
        # design_invalid plus observed_value/registered_threshold columns; the
        # verifier falsely reported primary_contrast_estimates_missing.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            ids=[
                'initial_pose_success_area_local_gap_minus_global_diversity',
                'signed_friction_success_area_local_gap_minus_global_diversity',
                'initial_pose_crossover_local_gap_minus_global_diversity',
                'signed_friction_crossover_local_gap_minus_global_diversity',
                'initial_pose_success_area_local_gap_minus_juicer_style',
                'signed_friction_success_area_local_gap_minus_juicer_style',
                'initial_pose_success_area_local_gap_minus_tuco_style',
                'signed_friction_success_area_local_gap_minus_tuco_style',
                'initial_pose_local_gap_slope_diffusion_policy_minus_behavior_transformer',
                'signed_friction_local_gap_slope_diffusion_policy_minus_behavior_transformer',
                'initial_pose_global_diversity_slope_diffusion_policy_minus_behavior_transformer',
                'signed_friction_global_diversity_slope_diffusion_policy_minus_behavior_transformer',
                'initial_pose_random_slope_diffusion_policy_minus_behavior_transformer',
                'signed_friction_random_slope_diffusion_policy_minus_behavior_transformer',
                'initial_pose_success_area_local_gap_minus_random',
                'signed_friction_success_area_local_gap_minus_random',
                'initial_pose_terminal_error_area_local_gap_minus_random',
                'signed_friction_terminal_error_area_local_gap_minus_random']
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator_label','status',
                    'estimate','simultaneous_lower','simultaneous_upper'])
                for contrast_id in ids:
                    comparator=contrast_id.rsplit('_minus_',1)[-1]
                    w.writerow(['analysis:9e2dcc03',contrast_id,comparator,
                                'not_estimable_design_invalid','','',''])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'gate','observed_value','registered_threshold','passed','preregistered'])
                w.writerow(['realized_support_reduction',0.0,'>=0.1',False,True])
                w.writerow(['transition_support',0.6,'>=0.25',True,True])
            c={'contract_id':'analysis:9e2dcc03','operational_spec':{
                'required_contrast_ids':ids,'comparator':'global_diversity',
                'contrast_comparators':{
                    contrast_id:contrast_id.rsplit('_minus_',1)[-1]
                    for contrast_id in ids},
                'validity_thresholds':{
                    'realized_support_reduction_min':.1,'transition_support_min':.25}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'inconclusive',
                    'resolution_status':'design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})

            gates.write_text(
                'gate,observed_value,registered_threshold,passed,preregistered\n'
                'realized_support_reduction,0.0,>=0.2,False,True\n')
            self.assertIn('primary_contrast_estimates_missing',verify_outputs([run],c,b)['problems'])

    def test_successful_audit_with_resolved_design_invalid_preserves_inconclusive_result(self):
        # MEASURED ON cycle-a-20260919, 2026-10-17: runner 382 used
        # pass for successful audit execution, resolved_design_invalid, and a
        # gate_name column. Its first failed gate was unmeasurable, so the old
        # verifier never reached three later numeric canonical failures.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            ids=[
                'initial_pose_success_auc_increment',
                'signed_friction_success_auc_increment',
                'initial_pose_support_distance_reduction_increment',
                'signed_friction_support_distance_reduction_increment',
                'diffusion_policy_behavior_transformer_slope_difference',
                'initial_pose_terminal_error_auc_sensitivity',
                'signed_friction_terminal_error_auc_sensitivity']
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator','status',
                    'estimate','simultaneous_lower','simultaneous_upper'])
                for contrast_id in ids:
                    comparator=('behavior_transformer' if contrast_id.startswith('diffusion_policy_')
                                else 'stronger_named_comparator')
                    w.writerow(['analysis:d938',contrast_id,comparator,
                                'not_estimable_design_invalid','','',''])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'gate_name','observed','operator','threshold','passed'])
                w.writerow(['realized_support_reduction','','>=',.1,False])
                w.writerow(['active_compute_ratio',2.500137,'<=',1.10,False])
                w.writerow(['allocation_interaction_se',.165625,'<=',.08,False])
            c={'contract_id':'analysis:d938','falsification_conditions':[
                'Classify the design as invalid rather than false if realized support reduction is below 0.10, active-compute ratio exceeds 1.10, or allocation-interaction SE exceeds 0.08.'],
                'operational_spec':{
                    'required_contrast_ids':ids,'comparator':'stronger_named_comparator',
                    'contrast_comparators':{
                        'diffusion_policy_behavior_transformer_slope_difference':'behavior_transformer'}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'pass',
                    'resolution_status':'resolved_design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})
            self.assertEqual(run.metrics['pass_fail'],'pass')
            gates.write_text(
                'gate_name,observed,operator,threshold,passed\n'
                'realized_support_reduction,,>=,0.1,False\n'
                'active_compute_ratio,2.500137,<=,1.20,False\n'
                'allocation_interaction_se,0.165625,<=,0.09,False\n')
            self.assertIn('primary_contrast_estimates_missing',
                          verify_outputs([run],c,b)['problems'])

    def test_runner_405_direction_columns_preserve_design_invalid_result(self):
        # MEASURED ON cycle-a-20260919, 2026-10-17: runner 405's
        # validity_gates.csv used threshold_direction=min/max; despite two
        # canonical failures, the verifier reported primary estimates missing.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            ids=[
                'auc_exact_tuco_utility_minus_permuted_utility__initial_pose',
                'auc_exact_tuco_utility_minus_permuted_utility__signed_friction',
                'utility_explained_share_of_local_gap_minus_random__initial_pose',
                'utility_explained_share_of_local_gap_minus_random__signed_friction',
                'auc_local_gap_repair_minus_exact_tuco_utility__initial_pose',
                'auc_local_gap_repair_minus_exact_tuco_utility__signed_friction',
                'slope_diffusion_policy_minus_behavior_transformer__initial_pose',
                'slope_diffusion_policy_minus_behavior_transformer__signed_friction']
            comparators={
                contrast_id: ('within_pool_permuted_utility' if 'permuted_utility' in contrast_id
                              else 'uniform_random_with_local_gap_minus_random_denominator'
                              if 'explained_share' in contrast_id else 'exact_tuco_utility'
                              if 'local_gap_repair' in contrast_id
                              else 'behavior_transformer_conditional_on_exact_tuco_utility')
                for contrast_id in ids}
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator','axis','status',
                    'estimate','simultaneous_lower','simultaneous_upper'])
                for contrast_id in ids:
                    axis='initial_pose' if contrast_id.endswith('initial_pose') else 'signed_friction'
                    w.writerow(['analysis:b1600dea',contrast_id,comparators[contrast_id],axis,
                                'not_estimable_design_invalid','','',''])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','gate','observed','threshold',
                    'threshold_direction','passed'])
                w.writerow(['analysis:b1600dea','allocation_interaction_se',
                            .25833333333333336,.08,'max',False])
                w.writerow(['analysis:b1600dea','minimum_independent_training_seeds',
                            2.0,5.0,'min',False])
            c={'contract_id':'analysis:b1600dea','operational_spec':{
                'required_contrast_ids':ids,'comparator':'registered_contrast_specific_comparator',
                'contrast_comparators':comparators,'validity_gates':{
                    'allocation_interaction_se_max':.08,
                    'minimum_independent_training_seeds_min':5}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'inconclusive',
                    'resolution_status':'not_estimable_design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})

            gates.write_text(
                'gate,observed,threshold,threshold_direction,passed\n'
                'allocation_interaction_se,0.25833333333333336,0.08,min,False\n')
            self.assertIn('primary_contrast_estimates_missing',
                          verify_outputs([run],c,b)['problems'])

    def test_runner_408_exact_minimum_and_maximum_gate_ids_preserve_inconclusive_result(self):
        # MEASURED ON cycle-a-20260919, 2026-10-17: runner 408 emitted
        # every canonical row as design-invalid and proved two failed gates
        # whose exact registered IDs use minimum_*/maximum_* prefixes, but the
        # verifier reported primary_contrast_estimates_missing.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            contrasts_and_comparators=[
                ('exact_utility_minus_permuted_utility_auc_initial_pose','permuted_utility'),
                ('exact_utility_minus_permuted_utility_auc_signed_friction','permuted_utility'),
                ('utility_attributable_fraction_initial_pose','local_gap_repair_minus_uniform_random'),
                ('utility_attributable_fraction_signed_friction','local_gap_repair_minus_uniform_random'),
                ('faithful_sieve_minus_exact_utility_auc_initial_pose','exact_tuco_utility'),
                ('faithful_sieve_minus_exact_utility_auc_signed_friction','exact_tuco_utility'),
                ('local_gap_minus_exact_utility_auc_initial_pose','exact_tuco_utility'),
                ('local_gap_minus_exact_utility_auc_signed_friction','exact_tuco_utility'),
                ('diffusion_policy_minus_behavior_transformer_distance_slope_initial_pose','behavior_transformer'),
                ('diffusion_policy_minus_behavior_transformer_distance_slope_signed_friction','behavior_transformer')]
            ids=[contrast_id for contrast_id,_ in contrasts_and_comparators]
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator_label','status',
                    'estimate','simultaneous_lower','simultaneous_upper'])
                for contrast_id,comparator in contrasts_and_comparators:
                    w.writerow(['analysis:b9ca497e',contrast_id,comparator,
                                'not_estimable_design_invalid','','',''])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','gate_id','observed','threshold','operator','passed'])
                w.writerow(['analysis:b9ca497e','minimum_independent_training_seeds',2,5,'>=',False])
                w.writerow(['analysis:b9ca497e','maximum_allocation_interaction_se',.54,.08,'<=',False])
            c={'contract_id':'analysis:b9ca497e','operational_spec':{
                'required_contrast_ids':ids,'comparator':'permuted_utility',
                'contrast_comparators':dict(contrasts_and_comparators),
                'validity_gates':{'minimum_independent_training_seeds':5,
                                  'maximum_allocation_interaction_se':.08,
                                  'required_axes':['initial_pose','signed_friction']}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'inconclusive',
                    'resolution_status':'design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})

            gates.write_text(
                'gate_id,observed,threshold,operator,passed\n'
                'minimum_independent_training_seeds,2,4,>=,False\n')
            self.assertIn('primary_contrast_estimates_missing',
                          verify_outputs([run],c,b)['problems'])

    def test_runner_424_boolean_gate_preserves_scientific_failure(self):
        # MEASURED ON cycle-a-20260919, 2026-10-17: runner 424 emitted
        # all seven canonical blank rows after its registered checkpoint-match
        # predicate failed, but the verifier reported estimates missing because
        # the predicate was boolean and the scientific verdict was `fail`.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            ids=[
                'overall_denoising_minus_consistency_flow_refinement_support_interaction',
                'lineage_train_seed_11_denoising_minus_consistency_flow_refinement_support_interaction',
                'lineage_train_seed_23_denoising_minus_consistency_flow_refinement_support_interaction',
                'lineage_train_seed_37_denoising_minus_consistency_flow_refinement_support_interaction',
                'leave_out_train_seed_11_denoising_minus_consistency_flow_refinement_support_interaction',
                'leave_out_train_seed_23_denoising_minus_consistency_flow_refinement_support_interaction',
                'leave_out_train_seed_37_denoising_minus_consistency_flow_refinement_support_interaction']
            comparator=(
                'consistency_flow loss-family four-versus-one refinement change '
                'in success-versus-support-distance slope')
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator','status',
                    'estimate','simultaneous_lower','simultaneous_upper'])
                for contrast_id in ids:
                    w.writerow(['analysis:fab4873',contrast_id,comparator,
                                'not_estimable_design_invalid','','',''])
            gates=root/'validity_gates.csv'
            gates.write_text(
                'gate,registered_threshold,observed_value,passed,evidence\n'
                'checkpoint_hash_matched_across_refinement,'
                'one checkpoint hash within each loss-family by lineage group,0,False,'
                '6 groups checked; each had 2 checkpoint hashes\n')
            c={'contract_id':'analysis:fab4873','operational_spec':{
                'required_contrast_ids':ids,'comparator':comparator,
                'validity_gates':{
                    'checkpoint_hash_matched_within_loss_family_lineage_across_refinement':True,
                    'complete_shared_state_factorial':True}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'fail',
                    'resolution_status':'not_estimable_design_invalid'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})
            self.assertEqual(run.metrics['pass_fail'],'fail')

            gates.write_text(
                'gate,registered_threshold,observed_value,passed,evidence\n'
                'checkpoint_hash_matched_across_refinement,'
                'one checkpoint hash in an unspecified grouping,0,False,ambiguous\n')
            self.assertIn('primary_contrast_estimates_missing',
                          verify_outputs([run],c,b)['problems'])

    def test_runner_522_registered_gate_evidence_is_not_coupled_to_resolution_prose(self):
        # MEASURED ON cycle-a-20260919, 2026-10-19: runner 522
        # emitted these exact rows and proved that 0.4517 exceeded the
        # registered 0.05 maximum, but design_invalid_registered_gate was not
        # in the verifier's resolution-status spelling list.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            contract_id=('analysis:3db221c21312a2b83dd95866d7ac89bfb8ef75c1421706459e1ab4193c2ba1dc')
            contrasts_and_estimands=[
                ('loss_family_by_refinement_by_support_distance_denoising_vs_consistency_flow',
                 'Loss-family-by-refinement-by-support-distance interaction.'),
                ('refinement_induced_slope_change_denoising_minus_consistency_flow',
                 'Denoising-minus-consistency/flow refinement-induced slope change.'),
                ('near_support_success_denoising_minus_consistency_flow',
                 'Near-support success equivalence within ±0.05.')]
            ids=[contrast_id for contrast_id,_ in contrasts_and_estimands]
            contrasts=root/'primary_contrasts.csv'
            with contrasts.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'analysis_contract_id','contrast_id','comparator','estimand','status',
                    'estimate','simultaneous_lower','simultaneous_upper','decision',
                    'analysis_evidence_role'])
                for contrast_id,estimand in contrasts_and_estimands:
                    w.writerow([contract_id,contrast_id,'consistency_flow',estimand,
                                'not_estimable_design_invalid','','','','design_invalid','primary'])
            gates=root/'validity_gates.csv'
            with gates.open('w',newline='') as f:
                w=csv.writer(f);w.writerow([
                    'gate_id','observed_value','threshold','comparison','passed','detail'])
                w.writerow(['near_support_abs_family_difference_max',
                            .45166666666666666,.05,'<=',False,'registered gate failed'])
            c={'contract_id':contract_id,'operational_spec':{
                'required_contrast_ids':ids,'comparator':'consistency_flow',
                'contrast_comparators':{contrast_id:'consistency_flow' for contrast_id in ids},
                'validity_gates':{'near_support_abs_family_difference_max':.05}}}
            b={'contract_id':c['contract_id'],'evidence_role':'primary','status':'ready'}
            run=SimpleNamespace(status='completed',tables=[
                {'name':contrasts.name,'path':str(contrasts)},
                {'name':gates.name,'path':str(gates)}],metrics={
                    'analysis_contract_id':c['contract_id'],'pass_fail':'fail',
                    'resolution_status':'design_invalid_registered_gate'},script_path=None)
            self.assertEqual(verify_outputs([run],c,b),{
                **b,'status':'verified','problems':[],'executed_code_sha256':[]})

            gates.write_text(
                'gate_id,observed_value,threshold,comparison,passed,detail\n'
                'near_support_abs_family_difference_max,0.45166666666666666,0.06,<=,False,'
                'unregistered threshold\n')
            self.assertIn('primary_contrast_estimates_missing',
                          verify_outputs([run],c,b)['problems'])

    def test_a_supporting_audit_in_schema_pairs_is_supporting(self):
        # cycle-a-20260919, 2026-10-18: analyst-1012 declared its
        # contact-mode audit supporting in the schema's [{key, column}] pairs.
        c={'contract_id':'current','statement':'s','operational_spec':{}}
        pairs={'handoff_checks':[{'column_mapping':[{'key':'analysis_evidence_role','column':'supporting'},{'key':'seed','column':'seed'}]}]}
        self.assertEqual(preflight(pairs,c,None),{'contract_id':'current','status':'supporting','evidence_role':'supporting'})
        primary={'handoff_checks':[{'column_mapping':[{'key':'seed','column':'seed'}]}]}
        with self.assertRaisesRegex(ValueError,'analysis_contract_mismatch'):
            preflight(primary,c,None)

    def test_a_supporting_audit_is_given_the_contract_file_too(self):
        # cycle-a-20260919, 2026-10-18: six supporting audits died on
        # "RESEARCHLAB_ANALYSIS_CONTRACT is required".
        from python_stats_lib.entrypoint import _give_blueprint_contract
        c={'contract_id':'current','statement':'s'}
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            script="import json,os;from pathlib import Path;c=json.loads(Path(os.environ['RESEARCHLAB_ANALYSIS_CONTRACT']).read_text());print(json.dumps({'check_id':'audit','pass_fail':'pass','analysis_contract_id':c['contract_id'],'value':1.0}))"
            b=Blueprint(blueprint_id='audit',check_id='audit',code=script,entrypoint=None,dataset=None,outcome=None,raw={})
            _give_blueprint_contract(b,{'contract_id':'current','status':'supporting','evidence_role':'supporting'},c)
            run=_run_blueprint(b,csv_root=root,output_root=root/'out',timeout_seconds=30,derived_indicators_for_blueprint=[])
            self.assertEqual(run.status,'completed',run.error)
            self.assertEqual(run.metrics['analysis_contract_id'],'current')
            unbound=Blueprint(blueprint_id='free',check_id='free',code='print(1)',entrypoint=None,dataset=None,outcome=None,raw={})
            _give_blueprint_contract(unbound,None,c)
            self.assertNotIn('analysis_contract',unbound.raw)

if __name__=='__main__':unittest.main()
