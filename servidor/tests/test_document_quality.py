import json
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import UUID
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app.eliot_document_quality import assess_report,extract_document_text
from app import eliot_document_analysis as doc
from app import eliot_document_quality_api as api

REPORT="""## 1) Alcance y límites
Solo este documento.
## 2) Hechos verificados con citas exactas
El documento declara auditoría. [L1-L2]
## 3) Posibles riesgos o contradicciones (hipótesis)
No se ha contrastado la implementación.
## 4) Preguntas o archivos adicionales necesarios
¿Qué pruebas respaldan la declaración?
## 5) Recomendaciones para revisión humana (no acciones ejecutadas)
Revisar evidencia antes de aceptar.
"""
ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');TASK=UUID('77777777-7777-4777-8777-777777777777');RUN=UUID('88888888-8888-4888-8888-888888888888')
SOURCE={'repository':'Nova/project','path':'docs/CI.md','ref':'live','sha':'a'*40,'content':'Documento\nAuditoría\nLímites'}
def payload(text=REPORT):return {'status':'completed','output':[{'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text}]}],'usage':{'input_tokens':50,'output_tokens':80}}
def failed(q):return {c['id'] for c in q['checks'] if c['state']=='failed'}

def test_new_document_has_exact_checks_but_no_semantic_or_business_acceptance():
 q=assess_report(doc.PREFIX+REPORT,prefix=doc.PREFIX,document_line_count=3)
 assert q['status']=='structural_checks_passed' and q['source_line_bounds_verified']
 assert not q['semantic_correctness_verified'] and q['human_review_required']
 assert len(q['checks'])==8

def test_historical_bounds_are_explicitly_unchecked_even_with_valid_citation_syntax():
 q=assess_report(doc.PREFIX+REPORT.replace('[L1-L2]','[L999]'),prefix=doc.PREFIX)
 assert not q['source_line_bounds_verified']
 assert next(c for c in q['checks'] if c['id']=='source_line_bounds')['state']=='not_checked'
 assert q['status']=='structural_checks_passed' # Syntax/structure only, not evidence validity.
 assert 'source_line_bounds' in failed(assess_report(REPORT.replace('[L1-L2]','[L999]'),document_line_count=3))

@pytest.mark.parametrize('report,check',[
 (REPORT.replace('## 4) Preguntas o archivos adicionales necesarios','## Otra sección'),'required_sections'),
 (REPORT.replace('Solo este documento.',''),'nonempty_sections'),
 (REPORT.replace('[L1-L2]','[L3-L2]'),'citation_syntax'),
 (REPORT.replace('[L1-L2]','')+'\n[L1]','facts_cited'),
 (REPORT+'\n'+'x'*6000,'report_size'),
 (REPORT+'\x00','control_characters'),
 (REPORT+'\ud800','control_characters'),
 (REPORT+'\nsk-proj-'+'A'*30,'credential_patterns'),
 (REPORT+'\n## 1) Alcance y límites\nExtra','required_sections'),
 (REPORT+' [L'+'9'*45+']','citation_syntax'),
 (REPORT+' [L2','citation_syntax'),
 (REPORT+' [l2]','citation_syntax'),
])
def test_invalid_reports_have_static_diagnostics_only(report,check):
 q=assess_report(report,document_line_count=3)
 assert q['status']=='requires_attention' and check in failed(q)
 assert report not in json.dumps(q)

def test_bold_numbered_headings_accents_and_unicode_content():
 body=REPORT.replace('## ','**').replace('límites','LIMITES').replace('Solo este documento.','Solo este documento. 😀')
 # The parser accepts supported Markdown styles, not arbitrary renamed sections.
 assert assess_report(body,document_line_count=3)['status']=='structural_checks_passed'

def test_extractor_keeps_the_whole_report_beyond_chat_limit():
 text=REPORT+'\n'+'x'*3500+'\nFINAL DOCUMENTAL'
 assert len(text)>3200 and extract_document_text(payload(text)).endswith('FINAL DOCUMENTAL')

@pytest.mark.parametrize('change',[
 lambda p:{**p,'status':'incomplete'},
 lambda p:{**p,'incomplete_details':{'reason':'max_output_tokens'}},
 lambda p:{**p,'output':[{'type':'function_call','name':'write_file'}]},
 lambda p:{**p,'output':[{'type':'message','role':'assistant','status':'in_progress','content':[]}]},
 lambda p:{**p,'output':[{'type':'message','role':'assistant','content':[{'type':'refusal','refusal':'No'}]}]},
 lambda p:{**p,'output':'invalid'},
])
def test_extractor_rejects_partial_refusal_tool_and_malformed_output(change):
 assert extract_document_text(change(payload())) is None

@pytest.mark.parametrize('text,ok',[
 (REPORT+'\n'+'x'*3500+'\nFINAL DOCUMENTAL',True),
 (REPORT+'\n'+'x'*6000,False),
 (REPORT.replace('Solo este documento.',''),False),
 (REPORT+'\n'+'x'*3300+'\nsk-proj-'+'A'*30,False),
])
def test_provider_result_checked_whole_without_truncation_or_retry(text,ok):
 response=MagicMock();response.status=200;response.read.return_value=json.dumps(payload(text)).encode();response.__enter__.return_value=response
 budget=MagicMock();budget.reserve.return_value=(True,'key')
 with patch.dict('os.environ',{'OPENAI_API_KEY':'fake-test-only'}),patch.object(doc,'documentary_enabled',return_value=True),patch.object(doc,'reserve_model_request',return_value=True),patch.object(doc,'record_token_usage'),patch.object(doc.urllib.request,'urlopen',return_value=response) as network:
  report,reason=doc.generate_document_report(str(ORG),'Review',SOURCE,budget_store=budget)
 assert network.call_count==1 and budget.reconcile.call_count==1
 if ok: assert report==doc.PREFIX+text and reason is None
 else: assert report is None and reason=='invalid_response'

app=FastAPI();app.include_router(api.router);client=TestClient(app)
URL=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution/document-runs/{RUN}/quality'
CUR=MagicMock()
@contextmanager
def cursor(_):yield CUR

def test_quality_endpoint_owner_and_exact_result_no_external_io():
 CUR.reset_mock();CUR.fetchall.return_value=[(RUN,'completed',doc.PREFIX+REPORT,'Nova/project','docs/CI.md','live','a'*40)]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor):
  result=client.get(URL)
 assert result.status_code==200 and result.json()['read_only']
 assert result.json()['provider_called'] is False and result.json()['source_fetched'] is False
 assert result.json()['task_completed'] is False
 assert not result.json()['quality']['source_line_bounds_verified']
 assert 'report' not in result.json() and REPORT not in result.text
 owner.assert_called_once_with(ORG,None,write=False)
 assert CUR.execute.call_args.args[1]==(ORG,TASK)

def test_anonymous_and_non_owner_denied_before_quality_storage():
 with patch.object(api,'_cursor') as db:
  assert client.get(URL).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403,'Owner required')),patch.object(api,'_cursor') as db:
  assert client.get(URL).status_code==403
 db.assert_not_called()

@pytest.mark.parametrize('rows',[[],[(TASK,'completed',REPORT,None,None,None,None)],[(RUN,'running',None,None,None,None,None)]])
def test_quality_reader_never_substitutes_a_different_result(rows):
 CUR.fetchall.return_value=rows
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.get(URL).status_code==409
