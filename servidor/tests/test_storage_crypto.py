"""Cifrado del almacén: llaves por empresa aisladas, archivos verificados y permisos de conexión firmados."""
import base64,os
import pytest
from app import eliot_storage_crypto as c

MASTER=base64.b64encode(bytes(range(32))).decode()
@pytest.fixture(autouse=True)
def env(monkeypatch):monkeypatch.setenv('ELIOT_STORAGE_MASTER_KEY',MASTER)
def pieces(data,size):return [data[i:i+size] for i in range(0,len(data),size)] or [b'']
def roundtrip(key,fid,data,inp=70000,out=50000):
 enc=b''.join(c.encrypt_stream(key,fid,pieces(data,inp)))
 assert len(enc)==c.encrypted_size(len(data))
 return enc,b''.join(c.decrypt_stream(key,fid,pieces(enc,out)))

@pytest.mark.parametrize('bad',['','no-base64!!',base64.b64encode(b'corta').decode(),base64.b64encode(b'x'*33).decode()])
def test_master_key_must_be_32_bytes(monkeypatch,bad):
 monkeypatch.setenv('ELIOT_STORAGE_MASTER_KEY',bad)
 assert c.configured() is False
 with pytest.raises(c.StorageCryptoError):c.seal_company_key(b'k'*32,'org')

def test_company_key_is_bound_to_its_company_and_never_stored_in_clear():
 key=c.new_company_key();other=c.new_company_key()
 assert len(key)==32 and key!=other
 sealed=c.seal_company_key(key,'org-a')
 assert sealed.startswith('nl360:v1:') and key not in base64.b64decode(sealed[9:]) and base64.b64encode(key).decode() not in sealed
 assert c.open_company_key(sealed,'org-a')==key
 assert c.seal_company_key(key,'org-a')!=sealed                      # nonce aleatorio
 with pytest.raises(c.StorageCryptoError):c.open_company_key(sealed,'org-b')   # copiada a otra empresa no abre
 with pytest.raises(c.StorageCryptoError):c.open_company_key(sealed[:-4]+'AAAA','org-a')
 with pytest.raises(c.StorageCryptoError):c.open_company_key('en claro','org-a')
 with pytest.raises(c.StorageCryptoError):c.open_provider_token(sealed,'org-a')  # un uso no abre el otro

def test_another_master_key_opens_nothing(monkeypatch):
 sealed=c.seal_company_key(b'k'*32,'org-a');token=c.seal_provider_token('1//refresh','h')
 monkeypatch.setenv('ELIOT_STORAGE_MASTER_KEY',base64.b64encode(b'z'*32).decode())
 with pytest.raises(c.StorageCryptoError):c.open_company_key(sealed,'org-a')
 with pytest.raises(c.StorageCryptoError):c.open_provider_token(token,'h')

def test_provider_token_roundtrip_bound_to_holding():
 sealed=c.seal_provider_token('1//refresh-token','holding-1')
 assert '1//refresh-token' not in sealed and c.open_provider_token(sealed,'holding-1')=='1//refresh-token'
 with pytest.raises(c.StorageCryptoError):c.open_provider_token(sealed,'holding-2')

@pytest.mark.parametrize('size',[0,1,c.CHUNK-1,c.CHUNK,c.CHUNK+1,2*c.CHUNK,3*c.CHUNK+12345])
def test_file_roundtrip_all_boundaries(size):
 data=os.urandom(size);key=c.new_company_key()
 enc,dec=roundtrip(key,'file-1',data)
 assert dec==data and (size<64 or data[:64] not in enc)

def test_file_only_opens_with_its_company_key_and_its_own_id():
 data=os.urandom(c.CHUNK+500);ka=c.new_company_key();kb=c.new_company_key()
 enc=b''.join(c.encrypt_stream(ka,'file-1',[data]))
 with pytest.raises(c.StorageCryptoError):b''.join(c.decrypt_stream(kb,'file-1',[enc]))
 with pytest.raises(c.StorageCryptoError):b''.join(c.decrypt_stream(ka,'file-2',[enc]))

def test_tampering_truncation_reordering_and_foreign_data_are_detected():
 data=os.urandom(3*c.CHUNK+10);key=c.new_company_key()
 enc=b''.join(c.encrypt_stream(key,'f',[data]));head=len(c.MAGIC)+8;blk=c.CHUNK+c.TAG
 flipped=bytearray(enc);flipped[head+5]^=1
 cases={'alterado':bytes(flipped),'sin el último bloque':enc[:head+3*blk],'cortado a medias':enc[:head+blk+100],
  'solo cabecera':enc[:head],'bloques cambiados de orden':enc[:head]+enc[head+blk:head+2*blk]+enc[head:head+blk]+enc[head+2*blk:],
  'con datos añadidos':enc+b'x'*40,'no es nuestro':b'%PDF-1.7 cualquier cosa','vacío':b''}
 for name,bad in cases.items():
  with pytest.raises(c.StorageCryptoError):b''.join(c.decrypt_stream(key,'f',[bad]))

def test_two_encryptions_of_the_same_file_differ():
 key=c.new_company_key();data=b'mismo contenido'*100
 assert b''.join(c.encrypt_stream(key,'f',[data]))!=b''.join(c.encrypt_stream(key,'f',[data]))

def test_connection_permit_is_signed_expires_and_binds_holding_and_subject():
 s=c.sign_state('holding-1','auth0|owner',now=1000)
 assert c.read_state(s,now=1000+c.STATE_TTL-1)==('holding-1','auth0|owner')
 with pytest.raises(c.StorageCryptoError):c.read_state(s,now=1000+c.STATE_TTL+1)
 body,mac=s.split('.')
 forged=base64.urlsafe_b64encode(base64.urlsafe_b64decode(body+'='*(-len(body)%4)).replace(b'holding-1',b'holding-2')).decode().rstrip('=')
 for bad in (forged+'.'+mac,body+'.'+'0'*64,body,'',s+'x','a.b.c'):
  with pytest.raises(c.StorageCryptoError):c.read_state(bad,now=1000)
 assert c.sign_state('holding-1','auth0|owner',now=1000)!=s
