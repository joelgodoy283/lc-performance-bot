/**
 * Definición de herramientas (Tool Calling) disponibles para la IA.
 * Cada tool tiene: nombre, descripción, parámetros JSON Schema, y función ejecutora.
 */
const { getAvailability, createAppointment, isCalendarConfigured } = require('../calendar/google-calendar');

// ─── Definición de tools para OpenRouter (formato OpenAI) ─────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'check_calendar_availability',
      description: 'Consulta la disponibilidad del taller en una fecha específica. Úsala cuando el cliente quiera conocer los días u horarios disponibles para un turno.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Fecha a consultar en formato YYYY-MM-DD. Calculala a partir de la FECHA ACTUAL indicada en el system prompt (ej: si hoy es 2026-06-22 y el cliente dice "mañana", usá "2026-06-23").',
          },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment',
      description: 'Crea un turno en el calendario del taller. Úsala solo cuando el cliente confirmó todos sus datos (nombre, auto, problema) y eligió fecha y hora.',
      parameters: {
        type: 'object',
        properties: {
          client_name: {
            type: 'string',
            description: 'Nombre completo del cliente',
          },
          car_info: {
            type: 'string',
            description: 'Descripción del vehículo: marca, modelo, año y problema. Ejemplo: "Ford Focus 2018 - Cambio de pastillas de freno"',
          },
          date: {
            type: 'string',
            description: 'Fecha del turno en formato YYYY-MM-DD. Calculala a partir de la FECHA ACTUAL indicada en el system prompt (ej: "mañana", "el lunes" → fecha real).',
          },
          start_time: {
            type: 'string',
            description: 'Hora de inicio en formato HH:MM. Ejemplo: "10:00"',
          },
          end_time: {
            type: 'string',
            description: 'Hora de fin estimada en formato HH:MM (generalmente 1 hora después). Ejemplo: "11:00"',
          },
          client_phone: {
            type: 'string',
            description: 'NO completar: el sistema adjunta automáticamente el número de WhatsApp del cliente. Dejalo vacío.',
          },
        },
        required: ['client_name', 'car_info', 'date', 'start_time', 'end_time'],
      },
    },
  },
];

// ─── Ejecutor de tools ────────────────────────────────────────────────────

async function executeTool(toolName, args, clientPhone) {
  if (!isCalendarConfigured()) {
    return JSON.stringify({
      error: 'Google Calendar no está configurado aún. El dueño del taller necesita terminar la configuración. Por ahora podés dejar tu nombre y número para que Lucas te contacte.',
    });
  }

  try {
    if (toolName === 'check_calendar_availability') {
      const result = await getAvailability(args.date);
      return JSON.stringify(result);
    }

    if (toolName === 'create_appointment') {
      const result = await createAppointment({
        summary:     `Turno: ${args.client_name} - ${args.car_info}`,
        description: `Cliente: ${args.client_name}\nVehículo: ${args.car_info}`,
        dateStr:     args.date,
        startTime:   args.start_time,
        endTime:     args.end_time,
        clientPhone: args.client_phone || clientPhone,
      });
      return JSON.stringify(result);
    }

    return JSON.stringify({ error: `Tool desconocida: ${toolName}` });
  } catch (err) {
    console.error(`[TOOL] Error ejecutando ${toolName}:`, err.message);
    return JSON.stringify({ error: `No se pudo ejecutar la acción: ${err.message}` });
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
