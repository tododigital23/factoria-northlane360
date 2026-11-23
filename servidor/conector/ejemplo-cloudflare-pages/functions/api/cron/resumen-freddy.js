import { conector } from '../../../freddy.config.mjs';
export const onRequestGet = ({ request, env }) => conector.resumen(request, env);
