const axios = require('axios');
const { getConfig, getServices, getConversationState, saveConversationState } = require('../database/db');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');
const { isEnabled: supabaseEnabled, getClientProfile, upsertClientProfile } = require('../supabase/client');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_HISTORY_MESSAGES = 20; // Mantener últimos N mensajes para no superar el contexto

/**
 * Llama a la API de OpenRouter con soporte de tool calling.
 * Ejecuta el loop de herramientas automáticamente hasta obtener una respuesta final.
 */
async function callOpenRouter(messages, systemPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  if (!apiKey || apiKey === 'sk-or-v1-xxxxxxxxxxxxxxxx') {
    return 'Lo siento, el asistente no está configurado aún. Por favor contactá directamente con Lucas al taller.';
  }

  const allMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  let iteraciones = 0;
  const MAX_ITER = 5; // Máximo de rondas de tool calling para evitar loops infinitos

  while (iteraciones < MAX_ITER) {
    iteraciones++;

    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: allMessages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        max_tokens: 1024,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lc-performance.com',
          'X-Title': 'LC Performance WhatsApp Bot',
        },
        timeout: 30000,
      }
    );

    const choice = response.data.choices[0];
    const message = choice.message;

    // Agregar la respuesta del asistente al historial de la llamada
    allMessages.push(message);

    // Si el modelo no pidió ninguna tool → respuesta final
    if (choice.finish_reason !== 'tool_calls' || !message.tool_calls?.length) {
      return message.content || 'Disculpá, no pude procesar tu consulta. ¿Podés repetirla?';
    }

    // Ejecutar cada tool call solicitada
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      console.log(`[AI] Ejecutando tool: ${toolName}`, args);
      const toolResult = await executeTool(toolName, args, null);

      allMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
    // Volver a llamar con los resultados de las tools
  }

  return 'Lo siento, tuve un problema al procesar tu solicitud. Por favor escribí "hablar con Lucas" para atención personalizada.';
}

/**
 * Construye el system prompt combinando el prompt configurable con la lista
 * actualizada de servicios cargados desde la solapa "Servicios".
 */
function buildSystemPrompt() {
  const base = getConfig('ai_prompt') || 'Eres un asistente de taller mecánico.';
  const services = getServices();

  if (!services.length) return base;

  const lines = services.map((s) => {
    const parts = [`- ${s.name}`];
    if (s.description) parts.push(s.description);
    let line = parts.join(': ');
    if (s.price)  line += ` | Precio: ${s.price}`;
    if (s.notes)  line += ` | A tener en cuenta: ${s.notes}`;
    return line;
  });

  return `${base}

SERVICIOS DEL TALLER (usá esta información para responder sobre servicios, precios y detalles):
${lines.join('\n')}`;
}

/**
 * Da formato al perfil del cliente para inyectarlo en el system prompt.
 */
function formatClientProfile(p) {
  const parts = [];
  if (p.nombre)          parts.push(`Nombre: ${p.nombre}`);
  if (p.vehiculos)       parts.push(`Vehículo(s): ${p.vehiculos}`);
  if (p.estilo)          parts.push(`Estilo de habla: ${p.estilo}`);
  if (p.ultimo_servicio) parts.push(`Último servicio: ${p.ultimo_servicio}`);
  if (p.resumen)         parts.push(`Resumen: ${p.resumen}`);
  return parts.join('\n');
}

/**
 * Parseo tolerante de JSON (quita fences ```json y texto alrededor).
 */
function parseJsonLoose(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Actualiza (con IA) el perfil del cliente en Supabase a partir de la
 * conversación. Throttle: en el primer mensaje y luego cada 4, para no
 * gastar tokens de más. Fire-and-forget (no bloquea la respuesta).
 */
async function maybeUpdateClientProfile(phone, history) {
  if (!supabaseEnabled()) return;
  try {
    const profile = await getClientProfile(phone);
    const userMsgs = history.filter((m) => m.role === 'user').length;
    if (profile && userMsgs % 4 !== 0) return; // throttle

    const transcript = history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
      .join('\n')
      .slice(-4000);

    const sys =
      'Analizá la conversación y devolvé SOLO un JSON válido (sin texto extra) con las claves: ' +
      'nombre (string|null), vehiculos (string|null), estilo (cómo habla el cliente: formal/informal, ' +
      'usa modismos, mensajes largos/cortos, etc.), resumen (1-2 frases sobre quién es y qué necesita), ' +
      'ultimo_servicio (string|null). Si un dato no aparece, devolvé null o mantené lo ya conocido.';
    const user = (profile ? `Perfil actual: ${JSON.stringify(profile)}\n\n` : '') + `Conversación:\n${transcript}`;

    const raw = await simpleCompletion(sys, user);
    const json = parseJsonLoose(raw);
    if (!json) return;

    await upsertClientProfile(phone, {
      nombre:          json.nombre          ?? profile?.nombre          ?? null,
      vehiculos:       json.vehiculos       ?? profile?.vehiculos       ?? null,
      estilo:          json.estilo          ?? profile?.estilo          ?? null,
      resumen:         json.resumen         ?? profile?.resumen         ?? null,
      ultimo_servicio: json.ultimo_servicio ?? profile?.ultimo_servicio ?? null,
    });
  } catch (err) {
    console.error('[AI] Error actualizando perfil del cliente:', err.message);
  }
}

/**
 * Procesa un mensaje entrante del cliente y retorna la respuesta del bot.
 * Gestiona el historial de conversación desde la base de datos.
 */
async function processMessage(phone, userText) {
  const systemPrompt = buildSystemPrompt();
  const state = getConversationState(phone);

  // Construir el mensaje de usuario
  const userMessage = { role: 'user', content: userText };

  // Si es la primera interacción, agregar contexto al prompt del sistema
  let contextualPrompt = state.is_new
    ? systemPrompt + '\n\nCONTEXTO: Este es el PRIMER mensaje de este cliente. Debes presentarte como asistente virtual con IA.'
    : systemPrompt;

  // Memoria de largo plazo: inyectar el perfil del cliente si existe
  const profile = await getClientProfile(phone);
  if (profile) {
    contextualPrompt +=
      '\n\nPERFIL DEL CLIENTE (memoria de interacciones previas; usalo para personalizar el trato, ' +
      'saludarlo por su nombre, recordar su vehículo y ADAPTAR TU TONO al de él):\n' +
      formatClientProfile(profile);
  }

  // Agregar mensaje al historial
  const history = [...state.history, userMessage];

  // Limitar historial para no superar el contexto del modelo
  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);

  let botReply;
  try {
    botReply = await callOpenRouter(trimmedHistory, contextualPrompt);
  } catch (err) {
    console.error('[AI] Error llamando a OpenRouter:', err.response?.data || err.message);
    botReply = 'Disculpá, tuve un problema técnico. Por favor escribí "hablar con Lucas" para atención directa o intentá de nuevo en unos minutos.';
  }

  // Guardar el estado actualizado
  const updatedHistory = [
    ...trimmedHistory,
    { role: 'assistant', content: botReply },
  ];

  saveConversationState(phone, updatedHistory, state.step, state.car_info, false);

  // Actualizar el perfil del cliente en segundo plano (no bloquea la respuesta)
  maybeUpdateClientProfile(phone, updatedHistory).catch(() => {});

  return botReply;
}

/**
 * Completado simple sin tool-calling. Útil para tareas internas como el
 * resumen diario. Devuelve el texto o null si no hay API key / falla.
 */
async function simpleCompletion(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  if (!apiKey || apiKey === 'sk-or-v1-xxxxxxxxxxxxxxxx') return null;

  try {
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 600,
        temperature: 0.5,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://lc-performance.com',
          'X-Title': 'LC Performance WhatsApp Bot',
        },
        timeout: 30000,
      }
    );
    return response.data.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('[AI] Error en simpleCompletion:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { processMessage, buildSystemPrompt, simpleCompletion };
