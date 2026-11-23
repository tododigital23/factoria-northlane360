import { conector } from '../../../freddy.config.mjs';
export const onRequestGet = ({ request, env }) => conector.consulta(request, env);
