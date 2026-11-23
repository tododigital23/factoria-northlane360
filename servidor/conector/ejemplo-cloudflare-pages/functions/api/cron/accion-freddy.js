import { conector } from '../../../freddy.config.mjs';
export const onRequestPost = ({ request, env }) => conector.accion(request, env);
