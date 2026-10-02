const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Appointment = require('../models/Appointment');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const { auth } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/appointments
// @desc    Get appointments for current user
// @access  Private
router.get('/', auth, [
  query('status').optional().isIn(['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { status, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    // Build filter based on user role
    let filter = {};
    if (req.user.role === 'patient') {
      filter.patient = req.user._id;
    } else if (req.user.role === 'doctor') {
      const doctor = await Doctor.findOne({ user: req.user._id });
      if (doctor) {
        filter.doctor = doctor._id;
      } else {
        return res.status(404).json({ message: 'Doctor profile not found' });
      }
    } else if (req.user.role === 'clinic_admin') {
      const clinic = await Clinic.findOne({ admin: req.user._id });
      if (clinic) {
        filter.clinic = clinic._id;
      } else {
        return res.status(404).json({ message: 'Clinic not found' });
      }
    }

    if (status) {
      filter.status = status;
    }

    const appointments = await Appointment.find(filter)
      .populate('patient', 'name email phone')
      .populate('doctor', 'specialty consultationFee')
      .populate({
        path: 'doctor',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      })
      .populate('clinic', 'name address phone')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ appointmentDate: -1, appointmentTime: -1 });

    const total = await Appointment.countDocuments(filter);

    res.json({
      appointments,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalAppointments: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Get appointments error:', error);
    res.status(500).json({ message: 'Server error while fetching appointments' });
  }
});

// @route   GET /api/appointments/:id
// @desc    Get single appointment by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id)
      .populate('patient', 'name email phone')
      .populate('doctor', 'specialty consultationFee')
      .populate({
        path: 'doctor',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      })
      .populate('clinic', 'name address phone');

    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check if user has access to this appointment
    const hasAccess = appointment.patient._id.toString() === req.user._id.toString() ||
                     (req.user.role === 'doctor' && appointment.doctor.user._id.toString() === req.user._id.toString()) ||
                     (req.user.role === 'clinic_admin' && appointment.clinic.admin.toString() === req.user._id.toString());

    if (!hasAccess) {
      return res.status(403).json({ message: 'Not authorized to view this appointment' });
    }

    res.json({ appointment });
  } catch (error) {
    console.error('Get appointment error:', error);
    res.status(500).json({ message: 'Server error while fetching appointment' });
  }
});

// @route   POST /api/appointments
// @desc    Create a new appointment
// @access  Private (Patient)
router.post('/', auth, [
  body('doctorId').isMongoId().withMessage('Valid doctor ID is required'),
  body('clinicId').isMongoId().withMessage('Valid clinic ID is required'),
  body('appointmentDate').isISO8601().withMessage('Valid appointment date is required'),
  body('appointmentTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Valid time format (HH:MM) is required'),
  body('reason').trim().isLength({ min: 10, max: 500 }).withMessage('Reason must be between 10 and 500 characters'),
  body('notes').optional().isLength({ max: 1000 }).withMessage('Notes must be less than 1000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only patients can book appointments' });
    }

    const { doctorId, clinicId, appointmentDate, appointmentTime, reason, notes } = req.body;

    // Check if doctor exists and is available
    const doctor = await Doctor.findById(doctorId)
      .populate('user', 'name email');
    
    if (!doctor) {
      return res.status(404).json({ message: 'Doctor not found' });
    }

    if (doctor.status === 'offline') {
      return res.status(400).json({ message: 'Doctor is currently offline' });
    }

    // Check if clinic exists
    const clinic = await Clinic.findById(clinicId);
    if (!clinic) {
      return res.status(404).json({ message: 'Clinic not found' });
    }

    // Check if doctor is associated with the clinic
    if (!clinic.doctors.includes(doctorId)) {
      return res.status(400).json({ message: 'Doctor is not available at this clinic' });
    }

    // Check for conflicting appointments
    const appointmentDateObj = new Date(appointmentDate);
    const existingAppointment = await Appointment.findOne({
      doctor: doctorId,
      appointmentDate: {
        $gte: new Date(appointmentDateObj.setHours(0, 0, 0, 0)),
        $lt: new Date(appointmentDateObj.setHours(23, 59, 59, 999))
      },
      appointmentTime: appointmentTime,
      status: { $in: ['scheduled', 'confirmed', 'in_progress'] }
    });

    if (existingAppointment) {
      return res.status(400).json({ message: 'Time slot is already booked' });
    }

    const appointment = new Appointment({
      patient: req.user._id,
      doctor: doctorId,
      clinic: clinicId,
      appointmentDate: appointmentDateObj,
      appointmentTime,
      reason,
      notes,
      consultationFee: doctor.consultationFee
    });

    await appointment.save();

    const populatedAppointment = await Appointment.findById(appointment._id)
      .populate('patient', 'name email phone')
      .populate('doctor', 'specialty consultationFee')
      .populate({
        path: 'doctor',
        populate: {
          path: 'user',
          select: 'name email phone'
        }
      })
      .populate('clinic', 'name address phone');

    res.status(201).json({
      message: 'Appointment booked successfully',
      appointment: populatedAppointment
    });
  } catch (error) {
    console.error('Create appointment error:', error);
    res.status(500).json({ message: 'Server error while creating appointment' });
  }
});

// @route   PUT /api/appointments/:id/status
// @desc    Update appointment status
// @access  Private (Doctor or Clinic Admin)
router.put('/:id/status', auth, [
  body('status').isIn(['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']).withMessage('Invalid status'),
  body('prescription').optional().isLength({ max: 2000 }).withMessage('Prescription must be less than 2000 characters'),
  body('followUpDate').optional().isISO8601().withMessage('Valid follow-up date is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { status, prescription, followUpDate } = req.body;
    const appointmentId = req.params.id;

    const appointment = await Appointment.findById(appointmentId)
      .populate('doctor', 'user')
      .populate('clinic', 'admin');

    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check authorization
    const isDoctor = req.user.role === 'doctor' && 
                    appointment.doctor.user._id.toString() === req.user._id.toString();
    const isClinicAdmin = req.user.role === 'clinic_admin' && 
                         appointment.clinic.admin.toString() === req.user._id.toString();

    if (!isDoctor && !isClinicAdmin) {
      return res.status(403).json({ message: 'Not authorized to update this appointment' });
    }

    const updateData = { status };
    if (prescription) updateData.prescription = prescription;
    if (followUpDate) updateData.followUpDate = followUpDate;

    const updatedAppointment = await Appointment.findByIdAndUpdate(
      appointmentId,
      updateData,
      { new: true }
    ).populate('patient', 'name email phone')
     .populate('doctor', 'specialty consultationFee')
     .populate({
       path: 'doctor',
       populate: {
         path: 'user',
         select: 'name email phone'
       }
     })
     .populate('clinic', 'name address phone');

    res.json({
      message: 'Appointment status updated successfully',
      appointment: updatedAppointment
    });
  } catch (error) {
    console.error('Update appointment status error:', error);
    res.status(500).json({ message: 'Server error while updating appointment status' });
  }
});

// @route   PUT /api/appointments/:id/rating
// @desc    Rate appointment
// @access  Private (Patient)
router.put('/:id/rating', auth, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review').optional().isLength({ max: 500 }).withMessage('Review must be less than 500 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only patients can rate appointments' });
    }

    const { rating, review } = req.body;
    const appointmentId = req.params.id;

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    if (appointment.patient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to rate this appointment' });
    }

    if (appointment.status !== 'completed') {
      return res.status(400).json({ message: 'Can only rate completed appointments' });
    }

    const updatedAppointment = await Appointment.findByIdAndUpdate(
      appointmentId,
      { rating, review },
      { new: true }
    ).populate('patient', 'name email phone')
     .populate('doctor', 'specialty consultationFee')
     .populate({
       path: 'doctor',
       populate: {
         path: 'user',
         select: 'name email phone'
       }
     })
     .populate('clinic', 'name address phone');

    // Update doctor's average rating
    const doctor = await Doctor.findById(appointment.doctor);
    if (doctor) {
      const allAppointments = await Appointment.find({
        doctor: appointment.doctor,
        rating: { $exists: true, $ne: null }
      });

      const totalRating = allAppointments.reduce((sum, apt) => sum + apt.rating, 0);
      const averageRating = totalRating / allAppointments.length;

      await Doctor.findByIdAndUpdate(appointment.doctor, {
        'rating.average': averageRating,
        'rating.count': allAppointments.length
      });
    }

    res.json({
      message: 'Appointment rated successfully',
      appointment: updatedAppointment
    });
  } catch (error) {
    console.error('Rate appointment error:', error);
    res.status(500).json({ message: 'Server error while rating appointment' });
  }
});

// @route   DELETE /api/appointments/:id
// @desc    Cancel appointment
// @access  Private (Patient)
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only patients can cancel appointments' });
    }

    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    if (appointment.patient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to cancel this appointment' });
    }

    if (['completed', 'cancelled'].includes(appointment.status)) {
      return res.status(400).json({ message: 'Cannot cancel this appointment' });
    }

    await Appointment.findByIdAndUpdate(req.params.id, { status: 'cancelled' });

    res.json({ message: 'Appointment cancelled successfully' });
  } catch (error) {
    console.error('Cancel appointment error:', error);
    res.status(500).json({ message: 'Server error while cancelling appointment' });
  }
});

module.exports = router;
