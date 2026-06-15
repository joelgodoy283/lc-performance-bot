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
            description: 'Fecha a consultar en formato YYYY-MM-DD. Ejemplo: "2024-12-20"',
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
            description: 'Fecha del turno en formato YYYY-MM-DD',
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
            description: 'Número de WhatsApp del cliente',
          },
        },
        required: ['client_name', 'car_info', 'date', 'start_time', 'end_time', 'client_phone'],
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
